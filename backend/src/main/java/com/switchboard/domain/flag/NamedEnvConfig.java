package com.switchboard.domain.flag;

/** A head config paired with its environment key (for responses keyed by env). */
public record NamedEnvConfig(String envKey, FlagEnvConfig config) {
}
