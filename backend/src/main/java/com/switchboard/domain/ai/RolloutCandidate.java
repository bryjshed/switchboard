package com.switchboard.domain.ai;

import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.TargetingConfig;
import java.util.UUID;

/** A live flag-env head the monitor should look at, with everything it needs. */
public record RolloutCandidate(
    UUID orgId,
    UUID projectId,
    UUID environmentId,
    String envKey,
    Flag flag,
    TargetingConfig config,
    boolean enabled,
    boolean killSwitchActive,
    int version) {
}
