package com.switchboard.domain.user;

import java.util.UUID;

/**
 * A person. Which identity provider vouches for them is not a property of the person, so it is
 * not a field here - see {@link UserIdentity}.
 */
public record User(
    UUID id,
    String email,
    String displayName,
    boolean onboardingCompleted,
    /**
     * Deprovisioned, by SCIM or by hand. A deactivated user is refused at sign-in rather than
     * deleted: audit entries name their actor and change requests name their approver, so
     * removing the row would orphan the record of who authorised a production change.
     */
    boolean deactivated) {
}
