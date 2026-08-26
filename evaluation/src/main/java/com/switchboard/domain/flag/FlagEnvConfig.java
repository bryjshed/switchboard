package com.switchboard.domain.flag;

import java.time.Instant;
import java.util.UUID;

/** Head row: the current targeting state of one flag in one environment. */
public record FlagEnvConfig(
    UUID flagId,
    UUID environmentId,
    boolean enabled,
    boolean killSwitchActive,
    TargetingConfig config,
    int version,
    Instant updatedAt,
    String updatedBy) {
}
