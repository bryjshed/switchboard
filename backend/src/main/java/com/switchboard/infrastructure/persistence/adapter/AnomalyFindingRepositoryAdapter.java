package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.ai.AnomalyFinding;
import com.switchboard.domain.ai.AnomalyFindingRepository;
import com.switchboard.domain.ai.AnomalyStatus;
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
        z_score, summary, status, suggested_proposal_id, created_at
        """;

    private final DatabaseClient db;

    public AnomalyFindingRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Mono<AnomalyFinding> insertIfAbsent(AnomalyFinding finding, String dedupeKey) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                INSERT INTO anomaly_findings
                    (environment_id, flag_key, variation_id, metric_key, baseline_rate, variant_rate,
                     z_score, summary, status, dedupe_key)
                VALUES (:envId, :flagKey, :variationId, :metricKey, :baselineRate, :variantRate,
                        :zScore, :summary, :status, :dedupeKey)
                ON CONFLICT (dedupe_key) DO NOTHING
                RETURNING
                """ + COLUMNS)
            .bind("envId", finding.environmentId())
            .bind("flagKey", finding.flagKey())
            .bind("metricKey", finding.metricKey())
            .bind("baselineRate", BigDecimal.valueOf(finding.baselineRate()))
            .bind("variantRate", BigDecimal.valueOf(finding.variantRate()))
            .bind("zScore", BigDecimal.valueOf(finding.zScore()))
            .bind("status", finding.status().name())
            .bind("dedupeKey", dedupeKey);
        spec = bindNullable(spec, "variationId", finding.variationId(), UUID.class);
        spec = bindNullable(spec, "summary", finding.summary(), String.class);
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
            row.get("created_at", Instant.class));
    }

    private static double toDouble(BigDecimal value) {
        return value == null ? 0d : value.doubleValue();
    }

    private static DatabaseClient.GenericExecuteSpec bindNullable(
        DatabaseClient.GenericExecuteSpec spec, String name, Object value, Class<?> type) {
        return value == null ? spec.bindNull(name, type) : spec.bind(name, value);
    }
}
