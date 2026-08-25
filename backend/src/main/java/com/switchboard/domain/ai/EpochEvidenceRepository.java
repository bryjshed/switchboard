package com.switchboard.domain.ai;

import java.time.Instant;
import java.util.UUID;
import reactor.core.publisher.Mono;

/**
 * The running supremum of each hypothesis's e-process, per allocation epoch.
 *
 * <p>Needed because the always-valid p-value inverts {@code sup E} over every look, not the latest
 * one. Reading the latest value instead would let a finding's own justification weaken as evidence
 * ebbed - a number that wanders back up is not a p-value, and would be at its most confusing in
 * exactly the situation where an operator is trying to decide whether to trust an automated
 * rollback.
 */
public interface EpochEvidenceRepository {

    /**
     * Records this look and returns the supremum including it.
     *
     * <p>Upserts on {@code (environment, flag, epoch, metric, variation)}, keeping the larger of
     * the stored and incoming values. Idempotent under a repeated scan: recording the same look
     * twice cannot move the supremum.
     */
    Mono<Double> record(EpochEvidenceKey key, double logEValue, double tau, UUID baselineVariationId);

    /** Drops evidence rows older than {@code before}. Called by the partition-maintenance job. */
    Mono<Long> deleteObservedBefore(Instant before);

    /** Identifies one hypothesis within one epoch. */
    record EpochEvidenceKey(
        UUID environmentId,
        String flagKey,
        Instant epochStartedAt,
        String metricKey,
        UUID variationId) {
    }
}
