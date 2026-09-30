package com.switchboard.domain.org;

import java.time.Instant;
import java.util.UUID;

/**
 * An email address invited into an org with a role, before or after that person has an account.
 *
 * <p>An invitation is never deleted: accepting or revoking it stamps a timestamp. That keeps the
 * row as the record of who let whom in, and makes "pending" a derived state rather than a flag
 * that could disagree with the timestamps.
 *
 * @param email always lowercased; matching at sign-in is case-insensitive
 * @param invitedBy the inviting caller's email, as the audit trail names actors
 */
public record OrgInvitation(
    UUID id,
    UUID orgId,
    String email,
    String role,
    String invitedBy,
    Instant createdAt,
    Instant acceptedAt,
    UUID acceptedUserId,
    Instant revokedAt) {

    public InvitationStatus status() {
        if (revokedAt != null) {
            return InvitationStatus.REVOKED;
        }
        return acceptedAt != null ? InvitationStatus.ACCEPTED : InvitationStatus.PENDING;
    }
}
