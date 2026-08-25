package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.ai.EpochEvidenceRepository;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Mono;

/** {@link EpochEvidenceRepository} over {@code rollout_epoch_evidence}. */
@Repository
public class EpochEvidenceRepositoryAdapter implements EpochEvidenceRepository {

    /**
     * Upsert keeping the larger of stored and incoming. GREATEST rather than a comparison in
     * application code so two scans racing cannot lose a supremum between read and write.
     */
    private static final String UPSERT_SQL = """
        INSERT INTO rollout_epoch_evidence (
            environment_id, flag_key, epoch_started_at, metric_key, variation_id,
            baseline_variation_id, max_log_e, last_log_e, tau, observed_at)
        VALUES (:envId, :flagKey, :epoch, :metricKey, :variationId,
                :baselineId, :logE, :logE, :tau, now())
        ON CONFLICT (environment_id, flag_key, epoch_started_at, metric_key, variation_id)
        DO UPDATE SET
            max_log_e = GREATEST(rollout_epoch_evidence.max_log_e, EXCLUDED.max_log_e),
            last_log_e = EXCLUDED.last_log_e,
            baseline_variation_id = EXCLUDED.baseline_variation_id,
            tau = EXCLUDED.tau,
            observed_at = now()
        RETURNING max_log_e
        """;

    private final DatabaseClient db;

    public EpochEvidenceRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Mono<Double> record(
        EpochEvidenceKey key, double logEValue, double tau, UUID baselineVariationId) {

        return db.sql(UPSERT_SQL)
            .bind("envId", key.environmentId())
            .bind("flagKey", key.flagKey())
            .bind("epoch", key.epochStartedAt())
            .bind("metricKey", key.metricKey())
            .bind("variationId", key.variationId())
            .bind("baselineId", baselineVariationId)
            .bind("logE", logEValue)
            .bind("tau", tau)
            .map(row -> row.get("max_log_e", Double.class))
            .one();
    }

    @Override
    public Mono<Long> deleteObservedBefore(Instant before) {
        return db.sql("DELETE FROM rollout_epoch_evidence WHERE observed_at < :before")
            .bind("before", before)
            .fetch()
            .rowsUpdated();
    }
}
