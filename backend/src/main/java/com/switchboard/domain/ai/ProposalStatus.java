package com.switchboard.domain.ai;

/**
 * Lifecycle of an AI proposal; only DRAFT is applicable.
 *
 * <p>There is no EXPIRED. It was allowed by the schema from V1 and nothing ever wrote it -
 * proposals do not expire, they are applied, rejected, or left in DRAFT indefinitely. A value
 * nothing produces still costs every reader a decision about whether to handle it, so V12
 * removed it.
 *
 * <p><b>DRAFT does not mean "untouched".</b> A proposal whose apply was parked for review is
 * also DRAFT - it has not been applied - and is distinguishable only by the open change request
 * pointing at it, which is why {@code AiProposalResponse} carries
 * {@code pendingChangeRequestId}. Applying it again is refused with a 409 rather than opening a
 * second parked request.
 */
public enum ProposalStatus {
    DRAFT,
    APPLIED,
    REJECTED
}
