package com.switchboard.application.changerequest;

import java.util.UUID;

/**
 * One environment's answer for one write an AI proposal wants to make. Carries
 * the environment identity as well as the decision so a caller that needs to
 * audit a bypass does not have to look the environment up a second time.
 */
public record ProposalGate(UUID environmentId, String envKey, ApprovalDecision decision) {
}
