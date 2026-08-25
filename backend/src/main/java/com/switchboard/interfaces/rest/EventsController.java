package com.switchboard.interfaces.rest;

import com.switchboard.domain.common.ValidationException;
import com.switchboard.interfaces.rest.api.EventsApi;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.interfaces.rest.model.EvalEventBatch;
import com.switchboard.interfaces.rest.model.EvalEventItem;
import com.switchboard.interfaces.rest.model.MetricEventBatch;
import com.switchboard.interfaces.rest.model.MetricEventItem;
import com.switchboard.interfaces.security.Principals;
import com.switchboard.interfaces.security.SdkKeyPrincipal;
import org.springframework.beans.factory.annotation.Value;
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
    private final boolean allowPublicMetricEvents;

    public EventsController(
        DatabaseClient db,
        @Value("${switchboard.sdk.client-keys.allow-metric-events:false}") boolean allowPublicMetricEvents) {
        this.db = db;
        this.allowPublicMetricEvents = allowPublicMetricEvents;
    }

    @Override
    public Mono<ResponseEntity<Void>> ingestEvalEvents(
        Mono<EvalEventBatch> evalEventBatch, ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .zipWith(evalEventBatch)
            .flatMap(t -> insertEvalEvents(t.getT1().environmentId(), t.getT2().getEvents()))
            .thenReturn(ResponseEntity.accepted().build());
    }

    /**
     * Metric ingestion, refused for public keys by default.
     *
     * <p>These rows are the input to an <b>automated write path</b>: the rollout monitor reads them
     * and can roll a flag back on what they say. A key shipped inside a browser bundle is readable
     * by anyone, so accepting metrics from one means accepting unauthenticated instructions to
     * change flags - post enough {@code {"metricKey":"error"}} and a healthy rollout gets reverted.
     * Neither the SRM gate nor the sequential test catches that: the allocation is fine and the
     * evidence is real, it is just forged.
     *
     * <p>Eval events stay open to public keys. Since rates are computed per distinct subject rather
     * than per event, forging them inflates a denominator and, if anything, makes the monitor less
     * likely to act.
     *
     * <p>If browser-side metrics are genuinely needed later, the fix is a {@code key_kind} stamp on
     * the rows plus excluding public-origin rows from the healing loop - a column, not a policy
     * argument. The property exists so an operator who has thought about that can opt in.
     */
    @Override
    public Mono<ResponseEntity<Void>> ingestMetricEvents(
        Mono<MetricEventBatch> metricEventBatch, ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .flatMap(principal -> principal.isPublic() && !allowPublicMetricEvents
                ? Mono.<SdkKeyPrincipal>error(new ForbiddenException(
                    "Metric events cannot be reported with a client-side SDK key: they drive "
                        + "automated rollbacks. Report them from your server."))
                : Mono.just(principal))
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
