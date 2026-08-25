package com.switchboard.domain.user;

import java.time.Instant;
import java.util.UUID;

/**
 * One provider identity linked to one user.
 *
 * <p>The relationship is many-to-one on purpose: a person who signs in through one provider today
 * and another tomorrow is one user with two linked identities, not two users.
 */
public record UserIdentity(UUID userId, String issuer, String subject, Instant linkedAt) {
}
