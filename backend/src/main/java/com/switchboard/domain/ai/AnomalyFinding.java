package com.switchboard.domain.ai;

import java.time.Instant;
import java.util.UUID;

/** A persisted rollout-monitor finding. */
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
    Instant createdAt) {
}
