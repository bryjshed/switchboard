package com.switchboard.domain.flag;

/** A flag paired with its head config in one environment (evaluation snapshot row). */
public record FlagAndConfig(Flag flag, FlagEnvConfig config) {
}
