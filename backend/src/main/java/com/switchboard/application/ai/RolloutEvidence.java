package com.switchboard.application.ai;

import com.switchboard.domain.ai.RolloutCandidate;
import com.switchboard.domain.ai.VariantAggregate;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Everything one flag-env contributed to a scan, before any decision is taken.
 *
 * <p>The two-phase shape is forced by the multiplicity correction: e-BH needs the whole family of
 * hypotheses in hand before it can say which of them clear the bar, and the family spans every flag
 * in the environment. So a scan measures everything first, then decides, rather than deciding one
 * flag at a time as the predecessor did.
 *
 * @param srmFailed when true, every hypothesis here is excluded from the families and the flag
 *     gets an SRM finding instead. Traffic did not arrive as configured, so the arms are not
 *     comparable populations and no rate comparison on them means anything
 */
record RolloutEvidence(
    RolloutCandidate candidate,
    Instant since,
    boolean windowTruncated,
    List<VariantAggregate> aggregates,
    VariantAggregate baseline,
    boolean srmFailed,
    double srmLogEValue,
    List<Hypothesis> hypotheses) {

    /** One challenger measured against the baseline on one metric. */
    record Hypothesis(
        RolloutEvidence evidence,
        Direction direction,
        String metricKey,
        VariantAggregate challenger,
        long challengerHits,
        long challengerSubjects,
        long baselineHits,
        long baselineSubjects,
        double tau,
        /** The running supremum over the epoch, not this look alone. */
        double logEValue,
        double zScore) {

        UUID variationId() {
            return challenger.variationId();
        }
    }

    /** Which way a hypothesis points, and therefore which family it joins. */
    enum Direction {
        /** Challenger errors more than baseline: heal. */
        DEGRADATION,
        /** Challenger converts more than baseline: optimize. */
        IMPROVEMENT
    }
}
