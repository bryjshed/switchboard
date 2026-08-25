package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.ai.AnomalyFinding;
import com.switchboard.domain.ai.AnomalyFindingRepository;
import com.switchboard.domain.ai.AnomalyKind;
import com.switchboard.domain.ai.AnomalyStatistics;
import com.switchboard.domain.ai.AnomalyStatus;
import com.switchboard.domain.ai.AnomalyTestKind;
import io.r2dbc.spi.Readable;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** anomaly_findings; the unique dedupe_key is what makes a rescan idempotent. */
@Repository
public class AnomalyFindingRepositoryAdapter implements AnomalyFindingRepository {

    private static final String COLUMNS = """
        id, environment_id, flag_key, variation_id, metric_key, baseline_rate, variant_rate,
        z_score, summary, status, suggested_proposal_id, created_at,
        kind, test_kind, log_e_value, p_value, alpha, family_size, family_rank, srm_p_value,
        tau, epoch_started_at, window_truncated, variant_subjects, variant_hits,
        baseline_subjects, baseline_hits, baseline_variation_id
        """;

    private static final String INSERT_SQL = """
        INSERT INTO anomaly_findings
            (environment_id, flag_key, variation_id, metric_key, baseline_rate, variant_rate,
             z_score, summary, status, dedupe_key,
             kind, test_kind, log_e_value, p_value, alpha, family_size, family_rank,
             srm_p_value, tau, epoch_started_at, window_truncated,
             variant_subjects, variant_hits, baseline_subjects, baseline_hits,
             baseline_variation_id)
        VALUES (:envId, :flagKey, :variationId, :metricKey, :baselineRate, :variantRate,
                :zScore, :summary, :status, :dedupeKey,
                :kind, :testKind, :logEValue, :pValue, :alpha, :familySize, :familyRank,
                :srmPValue, :tau, :epochStartedAt, :windowTruncated,
                :variantSubjects, :variantHits, :baselineSubjects, :baselineHits,
                :baselineVariationId)
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING
        """;

    private final DatabaseClient db;

    public AnomalyFindingRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Mono<AnomalyFinding> insertIfAbsent(AnomalyFinding finding, String dedupeKey) {
        AnomalyStatistics statistics = finding.statistics() == null
            ? AnomalyStatistics.none()
            : finding.statistics();

        DatabaseClient.GenericExecuteSpec spec = db.sql(INSERT_SQL + COLUMNS)
            .bind("envId", finding.environmentId())
            .bind("flagKey", finding.flagKey())
            .bind("metricKey", finding.metricKey())
            .bind("baselineRate", BigDecimal.valueOf(finding.baselineRate()))
            .bind("variantRate", BigDecimal.valueOf(finding.variantRate()))
            .bind("status", finding.status().name())
            .bind("dedupeKey", dedupeKey)
            .bind("kind", (finding.kind() == null ? AnomalyKind.DEGRADATION : finding.kind()).name())
            .bind("testKind", statistics.testKind().name())
            .bind("windowTruncated", statistics.windowTruncated());

        // An SRM finding has no z-score, and a misleading 0.00 in the UI is worse than an absent
        // value - so the column is nullable now and this must respect that rather than coercing.
        spec = bindNullable(spec, "zScore", decimal(statistics.zScore()), BigDecimal.class);
        spec = bindNullable(spec, "variationId", finding.variationId(), UUID.class);
        spec = bindNullable(spec, "summary", finding.summary(), String.class);
        spec = bindNullable(spec, "logEValue", statistics.logEValue(), Double.class);
        spec = bindNullable(spec, "pValue", statistics.pValue(), Double.class);
        spec = bindNullable(spec, "alpha", statistics.alpha(), Double.class);
        spec = bindNullable(spec, "familySize", statistics.familySize(), Integer.class);
        spec = bindNullable(spec, "familyRank", statistics.familyRank(), Integer.class);
        spec = bindNullable(spec, "srmPValue", statistics.srmPValue(), Double.class);
        spec = bindNullable(spec, "tau", statistics.tau(), Double.class);
        spec = bindNullable(spec, "epochStartedAt", statistics.epochStartedAt(), Instant.class);
        spec = bindNullable(spec, "variantSubjects", statistics.variantSubjects(), Long.class);
        spec = bindNullable(spec, "variantHits", statistics.variantHits(), Long.class);
        spec = bindNullable(spec, "baselineSubjects", statistics.baselineSubjects(), Long.class);
        spec = bindNullable(spec, "baselineHits", statistics.baselineHits(), Long.class);
        spec = bindNullable(spec, "baselineVariationId", statistics.baselineVariationId(), UUID.class);

        return spec.map(AnomalyFindingRepositoryAdapter::map).one();
    }

    @Override
    public Flux<AnomalyFinding> listByEnvironment(UUID environmentId, AnomalyStatus status) {
        StringBuilder sql = new StringBuilder(
            "SELECT " + COLUMNS + " FROM anomaly_findings WHERE environment_id = :envId");
        if (status != null) {
            sql.append(" AND status = :status");
        }
        sql.append(" ORDER BY created_at DESC LIMIT 200");
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql.toString()).bind("envId", environmentId);
        if (status != null) {
            spec = spec.bind("status", status.name());
        }
        return spec.map(AnomalyFindingRepositoryAdapter::map).all();
    }

    @Override
    public Mono<AnomalyFinding> findById(UUID anomalyId) {
        return db.sql("SELECT " + COLUMNS + " FROM anomaly_findings WHERE id = :id")
            .bind("id", anomalyId)
            .map(AnomalyFindingRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<AnomalyFinding> acknowledge(UUID anomalyId) {
        return db.sql("""
                UPDATE anomaly_findings SET status = 'ACKED'
                WHERE id = :id AND status = 'OPEN'
                RETURNING
                """ + COLUMNS)
            .bind("id", anomalyId)
            .map(AnomalyFindingRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<Void> markAutoRolledBack(UUID anomalyId) {
        return db.sql("UPDATE anomaly_findings SET status = 'AUTO_ROLLED_BACK' WHERE id = :id")
            .bind("id", anomalyId)
            .then();
    }

    @Override
    public Mono<Void> setSuggestedProposal(UUID anomalyId, UUID proposalId) {
        return db.sql("UPDATE anomaly_findings SET suggested_proposal_id = :proposalId WHERE id = :id")
            .bind("id", anomalyId)
            .bind("proposalId", proposalId)
            .then();
    }

    private static AnomalyFinding map(Readable row) {
        AnomalyStatistics statistics = new AnomalyStatistics(
            AnomalyTestKind.valueOf(row.get("test_kind", String.class)),
            row.get("log_e_value", Double.class),
            row.get("p_value", Double.class),
            row.get("alpha", Double.class),
            row.get("family_size", Integer.class),
            row.get("family_rank", Integer.class),
            row.get("srm_p_value", Double.class),
            row.get("tau", Double.class),
            row.get("epoch_started_at", Instant.class),
            Boolean.TRUE.equals(row.get("window_truncated", Boolean.class)),
            nullableDouble(row.get("z_score", BigDecimal.class)),
            row.get("baseline_variation_id", UUID.class),
            row.get("variant_subjects", Long.class),
            row.get("variant_hits", Long.class),
            row.get("baseline_subjects", Long.class),
            row.get("baseline_hits", Long.class));

        return new AnomalyFinding(
            row.get("id", UUID.class),
            row.get("environment_id", UUID.class),
            row.get("flag_key", String.class),
            row.get("variation_id", UUID.class),
            row.get("metric_key", String.class),
            toDouble(row.get("baseline_rate", BigDecimal.class)),
            toDouble(row.get("variant_rate", BigDecimal.class)),
            toDouble(row.get("z_score", BigDecimal.class)),
            row.get("summary", String.class),
            AnomalyStatus.valueOf(row.get("status", String.class)),
            row.get("suggested_proposal_id", UUID.class),
            row.get("created_at", Instant.class),
            AnomalyKind.valueOf(row.get("kind", String.class)),
            statistics);
    }

    private static double toDouble(BigDecimal value) {
        return value == null ? 0d : value.doubleValue();
    }

    private static Double nullableDouble(BigDecimal value) {
        return value == null ? null : value.doubleValue();
    }

    private static BigDecimal decimal(Double value) {
        return value == null ? null : BigDecimal.valueOf(value);
    }

    private static DatabaseClient.GenericExecuteSpec bindNullable(
        DatabaseClient.GenericExecuteSpec spec, String name, Object value, Class<?> type) {
        return value == null ? spec.bindNull(name, type) : spec.bind(name, value);
    }
}
