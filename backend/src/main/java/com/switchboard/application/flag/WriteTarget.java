package com.switchboard.application.flag;

import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.project.Environment;
import java.util.UUID;

/**
 * A resolved, access-checked flag-in-environment plus its current head config.
 * The environment carries its approval policy, so this is everything the change
 * request gate needs to decide between writing now and opening a review.
 */
public record WriteTarget(UUID orgId, Flag flag, Environment env, FlagEnvConfig head) {

    public UUID projectId() {
        return flag.projectId();
    }
}
