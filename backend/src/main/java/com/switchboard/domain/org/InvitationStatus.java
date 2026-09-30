package com.switchboard.domain.org;

/** Derived from an invitation's timestamps; see {@link OrgInvitation#status()}. */
public enum InvitationStatus {
    PENDING,
    ACCEPTED,
    REVOKED
}
