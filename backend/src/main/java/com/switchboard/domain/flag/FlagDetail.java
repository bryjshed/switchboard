package com.switchboard.domain.flag;

import java.util.List;

/** A flag with the head config of every environment of its project. */
public record FlagDetail(Flag flag, List<NamedEnvConfig> envConfigs) {

    public FlagDetail {
        envConfigs = envConfigs == null ? List.of() : List.copyOf(envConfigs);
    }
}
