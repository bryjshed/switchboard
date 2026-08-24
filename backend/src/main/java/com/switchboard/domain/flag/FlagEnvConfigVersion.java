package com.switchboard.domain.flag;

import java.time.Instant;
import java.util.UUID;

/** Immutable snapshot of one flag-env config version. */
public record FlagEnvConfigVersion(
    UUID flagId,
    UUID environmentId,
    int versionNumber,
    boolean enabled,
    boolean killSwitchActive,
    TargetingConfig config,
    String versionNote,
    String createdBy,
    UUID createdFromProposalId,
    UUID createdFromChangeRequestId,
    Instant createdAt) {
}
