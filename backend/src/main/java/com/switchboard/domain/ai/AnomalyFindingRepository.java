package com.switchboard.domain.ai;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Persistence for anomaly_findings. */
public interface AnomalyFindingRepository {

    /**
     * Inserts the finding unless its dedupe_key already exists. Empty means the
     * sweep already recorded this window - that is what makes scans idempotent.
     */
    Mono<AnomalyFinding> insertIfAbsent(AnomalyFinding finding, String dedupeKey);

    Flux<AnomalyFinding> listByEnvironment(UUID environmentId, AnomalyStatus status);

    Mono<AnomalyFinding> findById(UUID anomalyId);

    /** OPEN -&gt; ACKED; emits the updated row, or empty when it was not OPEN. */
    Mono<AnomalyFinding> acknowledge(UUID anomalyId);

    Mono<Void> markAutoRolledBack(UUID anomalyId);

    Mono<Void> setSuggestedProposal(UUID anomalyId, UUID proposalId);
}
