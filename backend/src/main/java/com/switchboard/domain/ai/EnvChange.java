package com.switchboard.domain.ai;

/** One environment's slice of a proposed change; null fields are left unchanged. */
public record EnvChange(String envKey, Boolean enabled, Boolean killSwitchActive, TargetingDraft targeting) {
}
