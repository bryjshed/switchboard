package com.switchboard.application.flag;

import java.util.UUID;

/**
 * What caused a versioned flag write. A direct hand edit carries neither id; an
 * AI apply carries the proposal; an approved change request carries the request.
 *
 * <p>Both ids are stamped onto the version snapshot, where a partial unique index
 * per column turns a second apply of the same proposal or request into a
 * database-level failure. That index is the backstop behind each caller's status
 * compare-and-set, and it is what survives two instances racing.
 */
public record WriteOrigin(UUID proposalId, UUID changeRequestId) {

    /** A hand edit: audited as the action itself, stamped with nothing. */
    public static final WriteOrigin DIRECT = new WriteOrigin(null, null);

    public WriteOrigin {
        if (proposalId != null && changeRequestId != null) {
            throw new IllegalArgumentException("A write has one origin, not two");
        }
    }

    public static WriteOrigin ofProposal(UUID proposalId) {
        return proposalId == null ? DIRECT : new WriteOrigin(proposalId, null);
    }

    public static WriteOrigin ofChangeRequest(UUID changeRequestId) {
        return changeRequestId == null ? DIRECT : new WriteOrigin(null, changeRequestId);
    }

    /**
     * The audit action a write with this origin is recorded under. AI applies have
     * always collapsed to AI_APPLY; an approved change request gets its own action
     * so the log says plainly that a human review is what let the change through.
     */
    public String auditAction(String directAction) {
        if (proposalId != null) {
            return "AI_APPLY";
        }
        return changeRequestId != null ? "CHANGE_REQUEST_APPLY" : directAction;
    }
}
