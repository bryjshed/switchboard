package com.switchboard.domain.project;

/**
 * One environment's approval policy, carried on the environment row itself.
 *
 * <p>Everything is off by default, so an environment that nobody has configured
 * behaves exactly as it did before change requests existed.
 *
 * <p>{@code requireApprovalForKill} is deliberately separate from
 * {@code requireApproval}: the kill switch is an emergency stop, and putting a
 * review queue in front of "turn it off now" is how an incident becomes an
 * outage. It bypasses approval unless an operator explicitly asks for it.
 *
 * <p>{@code allowAutomationBypass} is the same trade for the rollout monitor's
 * automated healing. It defaults to TRUE and only means anything when
 * {@code requireApproval} is on: an automated rollback fires during an error
 * spike and reverts traffic to the baseline that was already live, so making it
 * wait for a reviewer removes the point of automating it. A human applying an AI
 * proposal is never covered by this - they are gated exactly like a hand edit.
 */
public record ApprovalSettings(
    boolean requireApproval,
    int minApprovals,
    boolean allowSelfApproval,
    boolean requireApprovalForKill,
    boolean allowAutomationBypass) {

    public static final ApprovalSettings OFF = new ApprovalSettings(false, 1, false, false, true);

    public ApprovalSettings {
        if (minApprovals < 1 || minApprovals > 10) {
            throw new IllegalArgumentException("minApprovals must be between 1 and 10");
        }
    }

    /** True when a targeting update or rollback in this environment must be reviewed. */
    public boolean gatesWrites() {
        return requireApproval;
    }

    /** True only when approval is on AND the operator opted the kill switch into it. */
    public boolean gatesKillSwitch() {
        return requireApproval && requireApprovalForKill;
    }

    /**
     * True when an otherwise-gated write may still be performed immediately
     * because the actor is automation. Never consulted for a human actor.
     */
    public boolean bypassesAutomation() {
        return requireApproval && allowAutomationBypass;
    }
}
