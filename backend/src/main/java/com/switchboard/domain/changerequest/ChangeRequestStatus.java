package com.switchboard.domain.changerequest;

/**
 * PENDING is the only state a request can be reviewed in.
 *
 * <p>PENDING -> APPROVED once the approval threshold is met, and APPROVED ->
 * APPLIED once the write lands. A request that would have overwritten work done
 * since its base version goes STALE instead of clobbering it, which is the same
 * refusal a direct write gets from a stale {@code expectedVersion}.
 */
public enum ChangeRequestStatus {
    PENDING,
    APPROVED,
    DECLINED,
    APPLIED,
    WITHDRAWN,
    STALE
}
