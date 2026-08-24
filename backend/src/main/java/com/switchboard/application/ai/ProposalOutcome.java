package com.switchboard.application.ai;

import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.changerequest.ChangeRequest;

/**
 * What happened to an AI proposal apply: it either landed, or the environment
 * requires approval and it was parked as a change request.
 *
 * <p>The same 200-versus-202 contract the human write endpoints already publish.
 * When it is Pending the proposal is still DRAFT and the flag is untouched.
 */
public sealed interface ProposalOutcome {

    AiProposal proposal();

    /** The writes landed; the proposal is APPLIED. HTTP 200. */
    record Applied(AiProposal proposal) implements ProposalOutcome {
    }

    /**
     * Nothing was written. The proposal stays DRAFT and {@code request} is the
     * first of the change requests now standing in for it. HTTP 202.
     */
    record Pending(AiProposal proposal, ChangeRequest request) implements ProposalOutcome {
    }
}
