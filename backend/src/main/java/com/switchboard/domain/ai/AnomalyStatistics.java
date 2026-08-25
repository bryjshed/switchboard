package com.switchboard.domain.ai;

import java.time.Instant;
import java.util.UUID;

/**
 * The statistical evidence behind a finding, kept separate from the finding itself so that
 * {@link AnomalyFinding} stays about "what was found" and this stays about "on what grounds".
 *
 * <p>Everything here exists so a reviewer can reconstruct the decision months later. The
 * {@code alpha} that was applied depends on how many hypotheses were screened alongside this
 * one, so without {@link #familySize()} and {@link #familyRank()} the threshold is
 * unreconstructable and the finding is unfalsifiable.
 *
 * @param testKind which statistic produced {@code logEValue}
 * @param logEValue the running supremum of the e-process for this hypothesis over the epoch,
 *     in logs. A real effect overflows a double, which is why this is never stored unlogged
 * @param pValue always-valid, {@code min(1, 1/sup E)}. Monotone by construction because it
 *     inverts the supremum rather than the latest value
 * @param alpha the e-BH threshold actually applied
 * @param familySize hypotheses screened together in the scan that produced this
 * @param familyRank this hypothesis's position when the family was sorted by evidence
 * @param srmPValue the sample-ratio-mismatch gate's reading at the time. A finding is only
 *     ever written when this passed, so it records that the gate was checked, not that it fired
 * @param tau the mixture scale in force. Recorded because power depends on it and a later
 *     retune would otherwise make old findings uninterpretable
 * @param epochStartedAt when the evidence window opened - the last change to traffic allocation
 * @param windowTruncated true when max-lookback clipped the epoch, weakening the guarantee from
 *     "at most alpha forever" to "at most alpha per lookback window"
 * @param zScore descriptive only. Kept because it is the number an operator recognises, and
 *     because the API has always carried it. Null for an SRM finding, which has no z
 */
public record AnomalyStatistics(
    AnomalyTestKind testKind,
    Double logEValue,
    Double pValue,
    Double alpha,
    Integer familySize,
    Integer familyRank,
    Double srmPValue,
    Double tau,
    Instant epochStartedAt,
    boolean windowTruncated,
    Double zScore,
    UUID baselineVariationId,
    Long variantSubjects,
    Long variantHits,
    Long baselineSubjects,
    Long baselineHits) {

    /** Everything absent. For rows written before V5, and for tests that do not care. */
    public static AnomalyStatistics none() {
        return new AnomalyStatistics(
            AnomalyTestKind.TWO_PROPORTION_Z, null, null, null, null, null, null, null,
            null, false, null, null, null, null, null, null);
    }
}
