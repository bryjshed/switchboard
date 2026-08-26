package com.switchboard.interfaces.rest;

import com.switchboard.application.metric.MetricDefinitionService;
import com.switchboard.domain.metric.MetricDefinition;
import com.switchboard.interfaces.rest.api.MetricsApi;
import com.switchboard.interfaces.rest.model.MetricDefinitionCreateRequest;
import com.switchboard.interfaces.rest.model.MetricDefinitionResponse;
import com.switchboard.interfaces.rest.model.MetricDefinitionUpdateRequest;
import com.switchboard.interfaces.rest.model.MetricDirection;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Metric definitions. Thin over {@link MetricDefinitionService}, with static mappers. */
@RestController
public class MetricsController implements MetricsApi {

    private final MetricDefinitionService metrics;

    public MetricsController(MetricDefinitionService metrics) {
        this.metrics = metrics;
    }

    @Override
    public Mono<ResponseEntity<Flux<MetricDefinitionResponse>>> listMetricDefinitions(
        UUID projectId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                metrics.list(projectId, user.userId()).map(MetricsController::toResponse)));
    }

    @Override
    public Mono<ResponseEntity<MetricDefinitionResponse>> createMetricDefinition(
        UUID projectId, Mono<MetricDefinitionCreateRequest> request, ServerWebExchange exchange) {

        return Principals.currentUser()
            .zipWith(request)
            .flatMap(t -> metrics.create(projectId, t.getT1().userId(),
                t.getT2().getKey(),
                t.getT2().getName(),
                t.getT2().getDescription(),
                toDomain(t.getT2().getDirection()),
                t.getT2().getTau() == null ? -1d : t.getT2().getTau().doubleValue(),
                // Absent means the monitor MAY act. A metric someone bothered to define is
                // normally one they want acted on; the opt-out is for the noisy ones.
                t.getT2().getAutoAct() == null || t.getT2().getAutoAct()))
            .map(created -> ResponseEntity.status(HttpStatus.CREATED).body(toResponse(created)));
    }

    @Override
    public Mono<ResponseEntity<MetricDefinitionResponse>> updateMetricDefinition(
        UUID metricId, Mono<MetricDefinitionUpdateRequest> request, ServerWebExchange exchange) {

        return Principals.currentUser()
            .zipWith(request)
            .flatMap(t -> metrics.update(metricId, t.getT1().userId(),
                t.getT2().getName(),
                t.getT2().getDescription(),
                toDomain(t.getT2().getDirection()),
                t.getT2().getTau() == null ? null : t.getT2().getTau().doubleValue(),
                t.getT2().getAutoAct()))
            .map(updated -> ResponseEntity.ok(toResponse(updated)));
    }

    @Override
    public Mono<ResponseEntity<Void>> deleteMetricDefinition(UUID metricId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> metrics.delete(metricId, user.userId()))
            .thenReturn(ResponseEntity.noContent().build());
    }

    private static com.switchboard.domain.metric.MetricDirection toDomain(MetricDirection wire) {
        return wire == null
            ? null
            : com.switchboard.domain.metric.MetricDirection.valueOf(wire.getValue());
    }

    private static MetricDefinitionResponse toResponse(MetricDefinition metric) {
        return new MetricDefinitionResponse(
            metric.id(),
            metric.projectId(),
            metric.key(),
            metric.name(),
            MetricDirection.fromValue(metric.direction().name()),
            java.math.BigDecimal.valueOf(metric.tau()),
            metric.autoAct(),
            metric.createdAt())
            .description(metric.description())
            .updatedAt(metric.updatedAt());
    }
}
