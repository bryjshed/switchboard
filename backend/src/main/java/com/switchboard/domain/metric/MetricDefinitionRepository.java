package com.switchboard.domain.metric;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Persistence port for user-defined metrics. */
public interface MetricDefinitionRepository {

    Flux<MetricDefinition> findByProject(UUID projectId);

    /** By id alone; the project comes from the row, never from the request. */
    Mono<MetricDefinition> findById(UUID id);

    Mono<MetricDefinition> findByProjectAndKey(UUID projectId, String key);

    Mono<MetricDefinition> create(MetricDefinition definition);

    Mono<MetricDefinition> update(UUID id, String name, String description,
        MetricDirection direction, Double tau, Boolean autoAct);

    Mono<Void> delete(UUID id);

    /**
     * Seeds the two built-ins for a newly created project.
     *
     * <p>V10 gives every EXISTING project these; without this a project created afterwards
     * would have no metrics at all and the monitor would silently do nothing for it - which
     * looks identical to "no traffic yet" and is the kind of gap nobody notices for a month.
     */
    Mono<Void> seedDefaults(UUID projectId);
}
