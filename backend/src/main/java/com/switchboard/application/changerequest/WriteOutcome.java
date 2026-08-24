package com.switchboard.application.changerequest;

import com.switchboard.application.flag.EnvConfigResult;
import com.switchboard.domain.changerequest.ChangeRequest;

/**
 * What happened to a flag write that went through the approval gate: it either
 * landed as a new version, or it was parked as a change request awaiting review.
 *
 * <p>This is the shape behind the 200-versus-202 contract on the write endpoints.
 */
public sealed interface WriteOutcome {

    /** The write landed: a new config version exists. HTTP 200. */
    record Applied(EnvConfigResult result) implements WriteOutcome {
    }

    /** The environment requires approval: nothing was written. HTTP 202. */
    record Pending(ChangeRequest request) implements WriteOutcome {
    }
}
