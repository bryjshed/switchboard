package com.switchboard.domain.token;

import java.time.Instant;
import java.util.UUID;

/**
 * A non-interactive credential belonging to one person.
 *
 * <p>The plaintext token is never here: it exists once, in the response to the call that created
 * it, and only its SHA-256 is stored. {@code tokenPrefix} is display-only, so an owner can tell
 * their tokens apart in a list without either of you handling the real thing.
 *
 * @param expiresAt null means no expiry, which is allowed but discouraged - see the V7 migration
 */
public record PersonalAccessToken(
    UUID id,
    UUID userId,
    String name,
    String tokenPrefix,
    Instant expiresAt,
    Instant lastUsedAt,
    Instant createdAt,
    Instant revokedAt) {

    public boolean isRevoked() {
        return revokedAt != null;
    }

    public boolean isExpired(Instant now) {
        return expiresAt != null && !expiresAt.isAfter(now);
    }

    /** Revoked and expired are different states to an operator, but the same answer to a request. */
    public boolean isUsable(Instant now) {
        return !isRevoked() && !isExpired(now);
    }
}
