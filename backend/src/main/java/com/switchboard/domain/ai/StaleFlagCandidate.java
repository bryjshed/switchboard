package com.switchboard.domain.ai;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** A non-archived flag with the head state of every environment it lives in. */
public record StaleFlagCandidate(
    UUID orgId,
    UUID projectId,
    String flagKey,
    String flagName,
    Instant lastChangedAt,
    List<StaleFlagEnv> envs) {

    public StaleFlagCandidate {
        envs = envs == null ? List.of() : List.copyOf(envs);
    }
}
