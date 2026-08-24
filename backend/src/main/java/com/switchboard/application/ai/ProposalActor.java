package com.switchboard.application.ai;

import java.util.UUID;

/**
 * Who is drafting or applying. Background jobs have no logged-in caller, so they
 * borrow an org owner's {@code userId} for the access checks while {@code label}
 * (for example "switchboard-monitor") is what lands in the audit trail.
 *
 * <p>{@code automation} says the apply came from the rollout monitor rather than
 * from a person, which is the only thing that can use an environment's
 * {@code allowAutomationBypass}. It is never true for an apply that arrived over
 * HTTP: the two-argument constructor, which every human path uses, hard-codes it
 * to false so a caller cannot claim to be automation by mistake.
 */
public record ProposalActor(UUID userId, String label, boolean automation) {

    /** A person. */
    public ProposalActor(UUID userId, String label) {
        this(userId, label, false);
    }

    /** A background job, eligible for the automation bypass. */
    public static ProposalActor automation(UUID userId, String label) {
        return new ProposalActor(userId, label, true);
    }
}
