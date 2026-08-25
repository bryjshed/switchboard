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
    boolean onboardingCompleted) {
}
