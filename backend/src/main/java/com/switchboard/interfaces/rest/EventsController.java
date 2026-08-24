package com.switchboard.interfaces.rest;

import com.switchboard.domain.common.ValidationException;
import com.switchboard.interfaces.rest.api.EventsApi;
import com.switchboard.interfaces.rest.model.EvalEventBatch;
import com.switchboard.interfaces.rest.model.EvalEventItem;
import com.switchboard.interfaces.rest.model.MetricEventBatch;
import com.switchboard.interfaces.rest.model.MetricEventItem;
import com.switchboard.interfaces.security.Principals;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * SDK event ingestion. Each batch becomes ONE multi-row INSERT into the
 * partitioned events table; environment_id always comes from the SDK principal.
 * Responds 202 - ingestion is best-effort telemetry, not a transaction the SDK
 * should retry on.
 */
@RestController
public class EventsController implements EventsApi {

    private static final int MAX_BATCH = 1000;

    private final DatabaseClient db;

    public EventsController(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Mono<ResponseEntity<Void>> ingestEvalEvents(
        Mono<EvalEventBatch> evalEventBatch, ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .zipWith(evalEventBatch)
            .flatMap(t -> insertEvalEvents(t.getT1().environmentId(), t.getT2().getEvents()))
            .thenReturn(ResponseEntity.accepted().build());
    }

    @Override
    public Mono<ResponseEntity<Void>> ingestMetricEvents(
        Mono<MetricEventBatch> metricEventBatch, ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .zipWith(metricEventBatch)
            .flatMap(t -> insertMetricEvents(t.getT1().environmentId(), t.getT2().getEvents()))
            .thenReturn(ResponseEntity.accepted().build());
    }

    private Mono<Void> insertEvalEvents(UUID environmentId, List<EvalEventItem> events) {
        requireBatchSize(events.size());
        if (events.isEmpty()) {
            return Mono.empty();
        }
        StringBuilder sql = new StringBuilder(
            "INSERT INTO eval_events (environment_id, flag_key, context_key, variation_id, reason, occurred_at)"
                + " VALUES ");
        for (int i = 0; i < events.size(); i++) {
            if (i > 0) {
                sql.append(", ");
            }
            sql.append("(:env, :flagKey").append(i).append(", :contextKey").append(i)
                .append(", :variationId").append(i).append(", :reason").append(i)
                .append(", :occurredAt").append(i).append(")");
        }
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql.toString()).bind("env", environmentId);
        for (int i = 0; i < events.size(); i++) {
            EvalEventItem event = events.get(i);
            spec = spec.bind("flagKey" + i, event.getFlagKey())
                .bind("contextKey" + i, event.getContextKey())
                .bind("reason" + i, event.getReason() == null ? "UNKNOWN" : event.getReason().getValue())
                .bind("occurredAt" + i, event.getOccurredAt());
            spec = event.getVariationId() == null
                ? spec.bindNull("variationId" + i, UUID.class)
                : spec.bind("variationId" + i, event.getVariationId());
        }
        return spec.then();
    }

    private Mono<Void> insertMetricEvents(UUID environmentId, List<MetricEventItem> events) {
        requireBatchSize(events.size());
        if (events.isEmpty()) {
            return Mono.empty();
        }
        StringBuilder sql = new StringBuilder(
            "INSERT INTO metric_events (environment_id, context_key, metric_key, value, occurred_at) VALUES ");
        for (int i = 0; i < events.size(); i++) {
            if (i > 0) {
                sql.append(", ");
            }
            sql.append("(:env, :contextKey").append(i).append(", :metricKey").append(i)
                .append(", :value").append(i).append(", :occurredAt").append(i).append(")");
        }
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql.toString()).bind("env", environmentId);
        for (int i = 0; i < events.size(); i++) {
            MetricEventItem event = events.get(i);
            spec = spec.bind("contextKey" + i, event.getContextKey())
                .bind("metricKey" + i, event.getMetricKey())
                .bind("value" + i, event.getValue())
                .bind("occurredAt" + i, event.getOccurredAt());
        }
        return spec.then();
    }

    private static void requireBatchSize(int size) {
        if (size > MAX_BATCH) {
            throw new ValidationException("Batch too large: max " + MAX_BATCH + " events");
        }
    }
}
