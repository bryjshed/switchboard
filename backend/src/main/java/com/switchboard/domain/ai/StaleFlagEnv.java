package com.switchboard.domain.ai;

import com.switchboard.domain.flag.TargetingConfig;

/** One environment's head state as the stale sweep sees it. */
public record StaleFlagEnv(String envKey, boolean enabled, TargetingConfig config) {
}
