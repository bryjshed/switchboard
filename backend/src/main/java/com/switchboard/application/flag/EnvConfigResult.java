package com.switchboard.application.flag;

import com.switchboard.domain.flag.FlagEnvConfig;

/** A head config paired with its env key, as returned by targeting mutations. */
public record EnvConfigResult(String envKey, FlagEnvConfig head) {
}
