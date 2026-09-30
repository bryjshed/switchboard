package com.switchboard.domain.org;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Port for org invitations. Every state change is conditional on the invitation still being
 * pending and returns the row it changed, so two concurrent sign-ins (or a sign-in racing a
 * revoke) settle in the database: exactly one of them gets the row back.
 */
public interface OrgInvitationRepository {

    /**
     * Inserts a pending invitation. Fails with the store's integrity-violation error when one is
     * already pending for that (org, email).
     */
    Mono<OrgInvitation> createPending(UUID orgId, String email, String role, String invitedBy);

    /** Inserts an invitation that is accepted at birth, for an invitee who already had an account. */
    Mono<OrgInvitation> createAccepted(UUID orgId, String email, String role, String invitedBy, UUID userId);

    /** Pending invitations in one org, oldest first. */
    Flux<OrgInvitation> findPendingInOrg(UUID orgId);

    /** Pending invitations for one (lowercased) email, across every org, oldest first. */
    Flux<OrgInvitation> findPendingByEmail(String email);

    /** Marks one pending invitation accepted. Empty when it was no longer pending. */
    Mono<OrgInvitation> markAccepted(UUID invitationId, UUID userId);

    /** Marks every pending invitation for (org, email) accepted, returning those it changed. */
    Flux<OrgInvitation> markPendingAccepted(UUID orgId, String email, UUID userId);

    /** Revokes one pending invitation in one org. Empty when there is no such pending invitation. */
    Mono<OrgInvitation> revoke(UUID orgId, UUID invitationId);
}
