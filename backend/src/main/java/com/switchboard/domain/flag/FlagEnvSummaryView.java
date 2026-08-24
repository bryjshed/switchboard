package com.switchboard.domain.flag;

import java.time.Instant;

/**
 * Per-environment summary row for the flag list. {@code rolloutPercentage} is the
 * fallthrough-rollout weight of the flag's default variation, or null when the
 * fallthrough serves a fixed variation.
 */
public record FlagEnvSummaryView(
    String envKey,
    boolean enabled,
    boolean killSwitchActive,
    Integer rolloutPercentage,
    int version,
    Instant updatedAt,
    String updatedBy) {
}
