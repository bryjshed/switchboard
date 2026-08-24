package com.switchboard.domain.flag;

/** A flag's head config in one environment plus the env's current state version (stream patches). */
public record FlagHead(Flag flag, FlagEnvConfig config, String envKey, long stateVersion) {
}
