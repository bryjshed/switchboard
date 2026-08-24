package com.switchboard.infrastructure.persistence.adapter;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.springframework.r2dbc.core.DatabaseClient;
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
     */
    private static final String AGGREGATE_SQL = """
        WITH ev AS (
            SELECT %s AS bucket, variation_id, context_key, COUNT(*)::bigint AS n
            FROM eval_events
            WHERE environment_id = :envId AND flag_key = :flagKey
              AND occurred_at >= :since AND variation_id IS NOT NULL
            GROUP BY 1, 2, 3
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
            SELECT bucket, variation_id, SUM(n)::bigint AS eval_count FROM ev GROUP BY 1, 2
        ),
        mt AS (
            SELECT x.bucket, a.variation_id, m.metric_key, COUNT(*)::bigint AS n
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
        )
        SELECT k.bucket, k.variation_id,
               COALESCE((SELECT eval_count FROM evc
                         WHERE evc.bucket = k.bucket AND evc.variation_id = k.variation_id), 0) AS eval_count,
               COALESCE((SELECT n FROM mt WHERE mt.bucket = k.bucket
                         AND mt.variation_id = k.variation_id AND mt.metric_key = 'error'), 0) AS error_count,
               COALESCE((SELECT n FROM mt WHERE mt.bucket = k.bucket
                         AND mt.variation_id = k.variation_id AND mt.metric_key = 'conversion'), 0)
                   AS conversion_count
        FROM keys k
        ORDER BY k.bucket, k.variation_id
        """;

    private static final TypeReference<List<Variation>> VARIATIONS_TYPE = new TypeReference<>() {
    };
    private static final TypeReference<List<EnvRow>> ENVS_TYPE = new TypeReference<>() {
    };

    private final DatabaseClient db;
    private final ObjectMapper json;

    public RolloutMetricsRepositoryAdapter(DatabaseClient db, ObjectMapper json) {
        this.db = db;
        this.json = json;
    }

    @Override
    public Mono<List<VariantAggregate>> aggregate(UUID environmentId, String flagKey, Instant since) {
        String sql = AGGREGATE_SQL.formatted("timestamptz 'epoch'");
        return db.sql(sql)
            .bind("envId", environmentId)
            .bind("flagKey", flagKey)
            .bind("since", since)
            .map(RolloutMetricsRepositoryAdapter::mapAggregate)
            .all()
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

    @Override
    public Flux<RolloutCandidate> findRolloutCandidates() {
        return db.sql("""
                SELECT p.org_id, p.id AS project_id, e.id AS environment_id, e.key AS env_key,
                       f.id AS flag_id, f.key AS flag_key, f.name AS flag_name, f.description,
                       f.kind, f.variations, f.tags,
                       c.enabled, c.kill_switch_active, c.config, c.version
                FROM flag_env_configs c
                JOIN flags f ON f.id = c.flag_id AND f.archived_at IS NULL
                JOIN environments e ON e.id = c.environment_id
                JOIN projects p ON p.id = f.project_id
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
                JOIN environments e ON e.id = c.environment_id
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
            row.get("error_count", Long.class),
            row.get("conversion_count", Long.class));
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
            row.get("version", Integer.class));
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
