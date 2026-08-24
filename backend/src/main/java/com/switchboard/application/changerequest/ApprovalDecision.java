package com.switchboard.application.changerequest;

/**
 * What an environment's approval policy says about one write an AI proposal
 * wants to make.
 *
 * <p>The distinction between {@link #WRITE} and {@link #BYPASS} matters only to
 * the audit trail: both write immediately, but BYPASS means the environment
 * WOULD have required review and the write went through because the actor was
 * automation. That case gets an extra APPROVAL_BYPASS audit entry, so "every
 * write that skipped review" stays a single query.
 */
public enum ApprovalDecision {

    /** The environment does not gate this write. Behaves exactly as it always has. */
    WRITE,

    /** Nothing is written; a PENDING change request is opened instead. */
    REVIEW,

    /** Gated, but the actor is automation and the environment allows the bypass. */
    BYPASS;

    public boolean writesNow() {
        return this != REVIEW;
    }
}
