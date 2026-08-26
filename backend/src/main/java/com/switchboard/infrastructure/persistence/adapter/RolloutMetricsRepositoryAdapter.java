package com.switchboard.infrastructure.persistence.adapter;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.ai.MetricCount;
import com.switchboard.domain.ai.RolloutCandidate;
import com.switchboard.domain.ai.RolloutMetricsRepository;
import com.switchboard.domain.ai.StaleFlagCandidate;
import com.switchboard.domain.ai.StaleFlagEnv;
import com.switchboard.domain.ai.VariantAggregate;
import com.switchboard.domain.ai.VariantBucket;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagKind;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.transaction.reactive.TransactionalOperator;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Rollout telemetry over the partitioned event tables, plus the two scan
 * queries the jobs need. The aggregation runs entirely in one statement: eval
 * events give each context key its variation, metric events join to that
 * assignment by context key, and the outer select pivots the two metric keys
 * the monitor cares about into columns.
 */
@Repository
public class RolloutMetricsRepositoryAdapter implements RolloutMetricsRepository {

    /**
     * Attribution + pivot. The single %s slot is the bucket expression: a
     * constant for totals, date_trunc('hour', ...) for the hourly series.
     *
     * <p>Two attribution rules, both window-wide rather than per bucket:
     * a context belongs to the variation it was served most often in the window,
     * and its metric events count in the bucket where it was FIRST evaluated.
     * Bucketing a conversion by the hour it was recorded would put it in a
     * bucket with no matching evaluations, so every rate would read as zero;
     * counting it against the exposure hour is both meaningful and what an
     * experiment readout means by "this hour converted at X%%".
     *
     * <p><b>Subjects and events are both counted, and they are not the same number.</b>
     * {@code eval_count} and {@code error_count} count <em>events</em>; a server SDK
     * evaluating a flag in a hot loop emits hundreds of them for one user. Dividing one
     * by the other is a ratio of event counts, not a proportion, and feeding it to any
     * test that assumes independent Bernoulli trials understates the variance by roughly
     * the average evaluations-per-context - inflating a z-score by roughly its square
     * root. {@code subject_count} and {@code *_subjects} count DISTINCT context keys, which
     * is the unit a rate comparison actually needs. The event counts stay because the
     * dashboard's volume charts want them; the monitor must use the subject counts.
     *
     * <p>{@code rollout_subject_count} is narrowed to {@code reason = 'ROLLOUT'} for the
     * sample-ratio-mismatch gate. Traffic served by an individual target or a matched rule
     * never went through the fallthrough rollout, so counting it against the configured
     * weights would report a mismatch the moment anyone adds a targeting rule.
     */
    private static final String AGGREGATE_SQL = """
        WITH ev AS (
            SELECT %s AS bucket, variation_id, context_key, reason, COUNT(*)::bigint AS n
            FROM eval_events
            WHERE environment_id = :envId AND flag_key = :flagKey
              AND occurred_at >= :since AND variation_id IS NOT NULL
            GROUP BY 1, 2, 3, 4
        ),
        totals AS (
            SELECT variation_id, context_key, SUM(n)::bigint AS n FROM ev GROUP BY 1, 2
        ),
        assign AS (
            SELECT DISTINCT ON (context_key) context_key, variation_id
            FROM totals ORDER BY context_key, n DESC, variation_id
        ),
        exposure AS (
            SELECT context_key, MIN(bucket) AS bucket FROM ev GROUP BY 1
        ),
        evc AS (
            SELECT bucket, variation_id,
                   SUM(n)::bigint AS eval_count,
                   COUNT(DISTINCT context_key)::bigint AS subject_count,
                   COUNT(DISTINCT context_key) FILTER (WHERE reason = 'ROLLOUT')::bigint
                       AS rollout_subject_count
            FROM ev GROUP BY 1, 2
        ),
        mt AS (
            SELECT x.bucket, a.variation_id, m.metric_key,
                   COUNT(*)::bigint AS n,
                   COUNT(DISTINCT m.context_key)::bigint AS subjects
            FROM metric_events m
            JOIN assign a ON a.context_key = m.context_key
            JOIN exposure x ON x.context_key = m.context_key
            WHERE m.environment_id = :envId AND m.occurred_at >= :since
            GROUP BY 1, 2, 3
        ),
        keys AS (
            SELECT bucket, variation_id FROM evc
            UNION
            SELECT bucket, variation_id FROM mt
        ),
        /*
         * Metrics as a JSON map rather than two pivoted columns.
         *
         * The previous version selected 'error' and 'conversion' into four fixed columns, which
         * is what made the healing loop unable to act on anything a team actually measures. This
         * returns whatever metric keys are present, and the caller looks up the ones its metric
         * definitions name. A key with no events in the window is simply absent, which reads as
         * zero rather than as an error.
         */
        metrics_json AS (
            SELECT bucket, variation_id,
                   jsonb_object_agg(metric_key,
                       jsonb_build_object('events', n, 'subjects', subjects)) AS metrics
            FROM mt GROUP BY 1, 2
        )
        SELECT k.bucket, k.variation_id,
               COALESCE((SELECT eval_count FROM evc
                         WHERE evc.bucket = k.bucket AND evc.variation_id = k.variation_id), 0) AS eval_count,
               COALESCE((SELECT subject_count FROM evc
                         WHERE evc.bucket = k.bucket AND evc.variation_id = k.variation_id), 0)
                   AS subject_count,
               COALESCE((SELECT rollout_subject_count FROM evc
                         WHERE evc.bucket = k.bucket AND evc.variation_id = k.variation_id), 0)
                   AS rollout_subject_count,
               COALESCE((SELECT metrics FROM metrics_json mj
                         WHERE mj.bucket = k.bucket AND mj.variation_id = k.variation_id),
                        '{}'::jsonb) AS metrics
        FROM keys k
        ORDER BY k.bucket, k.variation_id
        """;

    private static final TypeReference<List<Variation>> VARIATIONS_TYPE = new TypeReference<>() {
    };
    private static final TypeReference<List<EnvRow>> ENVS_TYPE = new TypeReference<>() {
    };

    /** A plain Postgres memory literal: digits plus an optional unit. Nothing else is allowed. */
    private static final java.util.regex.Pattern WORK_MEM =
        java.util.regex.Pattern.compile("(?i)^\\d+(kB|MB|GB)?$");

    private static final ObjectMapper METRICS_JSON = new ObjectMapper();

    private final DatabaseClient db;
    private final ObjectMapper json;
    private final TransactionalOperator tx;
    private final String aggregateWorkMem;

    public RolloutMetricsRepositoryAdapter(
        DatabaseClient db,
        ObjectMapper json,
        TransactionalOperator tx,
        @Value("${switchboard.rollout-monitor.aggregate-work-mem:}") String aggregateWorkMem) {
        this.db = db;
        this.json = json;
        this.tx = tx;
        // Interpolated into SQL below, so it is validated HERE, at startup, where a bad value is
        // a failure to boot rather than a syntax error inside the monitor an hour later. It is
        // configuration and never request data, but a value that reaches a SQL string unchecked
        // is worth refusing on principle rather than on threat model.
        if (!aggregateWorkMem.isBlank() && !WORK_MEM.matcher(aggregateWorkMem.trim()).matches()) {
            throw new IllegalArgumentException(
                "switchboard.rollout-monitor.aggregate-work-mem must look like '64MB', got: "
                    + aggregateWorkMem);
        }
        this.aggregateWorkMem = aggregateWorkMem.trim();
    }

    /**
     * Optionally runs one aggregation with a raised {@code work_mem}.
     *
     * <h2>Off by default, and the measurements are why</h2>
     *
     * <p>It looked like an easy win and is not a general one. At 2 M events for a single flag
     * this query spills a ~31 MB sort to disk and raising {@code work_mem} cut it from 4.4 s to
     * 3.6 s. At 500 k events per flag across eight flags it made a full scan measurably
     * <em>slower</em> (44.1 s against 40.8 s) - because at that size the sort never spills, so
     * there is nothing to buy and only variance to measure.
     *
     * <p>{@code work_mem} is per sort node per connection. With the scan running four
     * candidates at once and this query carrying several sort nodes, a 64 MB default is a
     * multi-hundred-megabyte peak on every deployment in exchange for a benefit only some of
     * them can realise. So it ships blank - Postgres' own default applies - and an operator
     * whose flags carry millions of events per epoch can set it deliberately, having measured.
     *
     * <p><b>When it IS set, {@code SET LOCAL} and the query must run on the same connection</b>,
     * or the SET applies to a connection that returns to the pool and the query runs at the
     * default anyway - a tuning change that looks applied and does nothing. The transaction is
     * what guarantees it: R2DBC pins the connection to the reactive context for its life.
     * {@code SET LOCAL} also reverts at commit, so an evaluation request that borrows the
     * connection next does not inherit a large sort budget.
     *
     * <p>The value is interpolated rather than bound because Postgres does not accept a
     * parameter in SET. It is configuration, never request data, and is rejected at startup if
     * it is not a plain Postgres memory literal.
     */
    private <T> Flux<T> withRaisedWorkMem(Flux<T> query) {
        if (aggregateWorkMem.isEmpty()) {
            // No transaction either: wrapping a read in one to change nothing would cost a
            // round trip per aggregation for no reason.
            return query;
        }
        return db.sql("SET LOCAL work_mem = '" + aggregateWorkMem + "'")
            .then()
            .thenMany(query)
            .as(tx::transactional);
    }

    @Override
    public Mono<List<VariantAggregate>> aggregate(UUID environmentId, String flagKey, Instant since) {
        String sql = AGGREGATE_SQL.formatted("timestamptz 'epoch'");
        return withRaisedWorkMem(db.sql(sql)
                .bind("envId", environmentId)
                .bind("flagKey", flagKey)
                .bind("since", since)
                .map(RolloutMetricsRepositoryAdapter::mapAggregate)
                .all())
            .collectList();
    }

    @Override
    public Flux<VariantBucket> hourlyBuckets(UUID environmentId, String flagKey, Instant since) {
        String sql = AGGREGATE_SQL.formatted("date_trunc('hour', occurred_at)");
        return db.sql(sql)
            .bind("envId", environmentId)
            .bind("flagKey", flagKey)
            .bind("since", since)
            .map(row -> Map.entry(row.get("bucket", Instant.class), mapAggregate(row)))
            .all()
            .collectList()
            .flatMapIterable(rows -> {
                Map<Instant, List<VariantAggregate>> byBucket = new LinkedHashMap<>();
                rows.forEach(entry -> byBucket
                    .computeIfAbsent(entry.getKey(), k -> new ArrayList<>())
                    .add(entry.getValue()));
                return byBucket.entrySet().stream()
                    .map(entry -> new VariantBucket(entry.getKey(), entry.getValue()))
                    .toList();
            });
    }

    /**
     * Every live head, each carrying the start of its current allocation epoch.
     *
     * <p>The epoch is found by a run-length scan over the append-only version history: fingerprint
     * every version's allocation-bearing fields, mark where the fingerprint changes, and take the
     * earliest {@code created_at} in the run the head belongs to. That is the last moment traffic
     * was reallocated, which is the only origin from which an anytime-valid statistic means
     * anything - see {@link RolloutCandidate#epochStartedAt()}.
     *
     * <p>A version whose note changed but whose weights did not stays inside the same run, so
     * editing a description does not throw away accumulated evidence.
     */
    @Override
    public Flux<RolloutCandidate> findRolloutCandidates() {
        return db.sql("""
                WITH versioned AS (
                    SELECT flag_id, environment_id, version_number, created_at,
                           rollout_allocation_fingerprint(enabled, kill_switch_active, config)
                               AS allocation
                    FROM flag_env_config_versions
                ),
                marked AS (
                    SELECT *,
                           CASE WHEN allocation IS DISTINCT FROM LAG(allocation) OVER (
                                    PARTITION BY flag_id, environment_id ORDER BY version_number)
                                THEN 1 ELSE 0 END AS changed
                    FROM versioned
                ),
                runs AS (
                    SELECT *,
                           SUM(changed) OVER (PARTITION BY flag_id, environment_id
                                              ORDER BY version_number) AS run_id
                    FROM marked
                ),
                epoch AS (
                    SELECT DISTINCT ON (flag_id, environment_id)
                           flag_id, environment_id,
                           MIN(created_at) OVER (PARTITION BY flag_id, environment_id, run_id)
                               AS epoch_started_at
                    FROM runs
                    ORDER BY flag_id, environment_id, version_number DESC
                )
                SELECT p.org_id, p.id AS project_id, e.id AS environment_id, e.key AS env_key,
                       f.id AS flag_id, f.key AS flag_key, f.name AS flag_name, f.description,
                       f.kind, f.variations, f.tags,
                       c.enabled, c.kill_switch_active, c.config, c.version,
                       ep.epoch_started_at
                FROM flag_env_configs c
                JOIN flags f ON f.id = c.flag_id AND f.archived_at IS NULL
                -- An archived environment is frozen against ordinary config writes, so the
                -- monitor could detect a bad rollout there and then fail to act on it. Not a
                -- candidate.
                JOIN environments e ON e.id = c.environment_id AND e.archived_at IS NULL
                JOIN projects p ON p.id = f.project_id
                LEFT JOIN epoch ep ON ep.flag_id = c.flag_id AND ep.environment_id = c.environment_id
                """)
            .map(this::mapCandidate)
            .all();
    }

    @Override
    public Flux<StaleFlagCandidate> findStaleFlagCandidates() {
        return db.sql("""
                SELECT p.org_id, p.id AS project_id, f.key AS flag_key, f.name AS flag_name,
                       MAX(c.updated_at) AS last_changed,
                       json_agg(json_build_object(
                           'envKey', e.key, 'enabled', c.enabled, 'config', c.config))::text AS envs
                FROM flags f
                JOIN projects p ON p.id = f.project_id
                JOIN flag_env_configs c ON c.flag_id = f.id
                JOIN environments e ON e.id = c.environment_id AND e.archived_at IS NULL
                WHERE f.archived_at IS NULL
                GROUP BY p.org_id, p.id, f.key, f.name
                """)
            .map(this::mapStale)
            .all();
    }

    // ---------------------------------------------------------------- mapping

    private static VariantAggregate mapAggregate(Readable row) {
        return new VariantAggregate(
            row.get("variation_id", UUID.class),
            row.get("eval_count", Long.class),
            row.get("subject_count", Long.class),
            row.get("rollout_subject_count", Long.class),
            readMetrics(row.get("metrics", io.r2dbc.postgresql.codec.Json.class)));
    }

    /**
     * The {@code metrics} JSON map into typed counts.
     *
     * <p>Parsed by hand rather than through Jackson: the shape is two longs per key, fixed by
     * the query directly above, and a databind round trip would add a dependency on that shape
     * being described in two places instead of one.
     */
    private static Map<String, MetricCount> readMetrics(io.r2dbc.postgresql.codec.Json json) {
        if (json == null) {
            return Map.of();
        }
        try {
            com.fasterxml.jackson.databind.JsonNode root = METRICS_JSON.readTree(json.asString());
            Map<String, MetricCount> out = new LinkedHashMap<>();
            root.properties().forEach(entry -> out.put(entry.getKey(), new MetricCount(
                entry.getValue().path("events").asLong(0L),
                entry.getValue().path("subjects").asLong(0L))));
            return Map.copyOf(out);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot read the aggregated metrics map", e);
        }
    }

    private RolloutCandidate mapCandidate(Readable row) {
        Flag flag = new Flag(
            row.get("flag_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("flag_key", String.class),
            row.get("flag_name", String.class),
            row.get("description", String.class),
            FlagKind.valueOf(row.get("kind", String.class)),
            readVariations(row.get("variations", String.class)),
            List.of(row.get("tags", String[].class)),
            false);
        return new RolloutCandidate(
            row.get("org_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("environment_id", UUID.class),
            row.get("env_key", String.class),
            flag,
            readConfig(row.get("config", String.class)),
            Boolean.TRUE.equals(row.get("enabled", Boolean.class)),
            Boolean.TRUE.equals(row.get("kill_switch_active", Boolean.class)),
            row.get("version", Integer.class),
            row.get("epoch_started_at", Instant.class));
    }

    private StaleFlagCandidate mapStale(Readable row) {
        List<EnvRow> envRows = readEnvs(row.get("envs", String.class));
        return new StaleFlagCandidate(
            row.get("org_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("flag_key", String.class),
            row.get("flag_name", String.class),
            row.get("last_changed", Instant.class),
            envRows.stream()
                .map(env -> new StaleFlagEnv(env.envKey(), env.enabled(), env.config()))
                .toList());
    }

    /** Shape of one element of the json_agg above. */
    private record EnvRow(String envKey, boolean enabled, TargetingConfig config) {
    }

    private List<Variation> readVariations(String raw) {
        try {
            return json.readValue(raw, VARIATIONS_TYPE);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot read flag variations", e);
        }
    }

    private TargetingConfig readConfig(String raw) {
        try {
            return json.readValue(raw, TargetingConfig.class);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot read targeting config", e);
        }
    }

    private List<EnvRow> readEnvs(String raw) {
        try {
            return json.readValue(raw, ENVS_TYPE);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot read env head configs", e);
        }
    }
}
