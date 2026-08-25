package com.switchboard.domain.ai;

import java.time.Instant;
import java.util.UUID;

/**
 * A persisted rollout-monitor finding.
 *
 * <p>{@code baselineRate} and {@code variantRate} are proportions of exposed <em>subjects</em>,
 * not ratios of event counts. For an SRM finding they carry the expected and observed shares of
 * traffic instead, so the same two columns render sensibly for both kinds.
 *
 * @param statistics the grounds for the finding; see {@link AnomalyStatistics}
 */
public record AnomalyFinding(
    UUID id,
    UUID environmentId,
    String flagKey,
    UUID variationId,
    String metricKey,
    double baselineRate,
    double variantRate,
    double zScore,
    String summary,
    AnomalyStatus status,
    UUID suggestedProposalId,
    Instant createdAt,
    AnomalyKind kind,
    AnomalyStatistics statistics) {

    /** The shape the pre-V5 call sites used, defaulting the new fields. */
    public AnomalyFinding(
        UUID id,
        UUID environmentId,
        String flagKey,
        UUID variationId,
        String metricKey,
        double baselineRate,
        double variantRate,
        double zScore,
        String summary,
        AnomalyStatus status,
        UUID suggestedProposalId,
        Instant createdAt) {

        this(id, environmentId, flagKey, variationId, metricKey, baselineRate, variantRate,
            zScore, summary, status, suggestedProposalId, createdAt,
            AnomalyKind.DEGRADATION, AnomalyStatistics.none());
    }
}
