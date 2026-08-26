package com.switchboard.domain.user;

import java.time.Instant;
import java.util.UUID;

/**
 * A user as SCIM sees them: the person, plus the two fields only provisioning cares about.
 *
 * <p>Separate from {@link User} rather than added to it, because {@code externalId} and
 * deactivation are facts about an IdP's relationship with a person, not about the person. Every
 * other part of the product reads {@link User} and is entirely unaware SCIM exists.
 *
 * @param deactivatedAt null means active. A timestamp rather than a flag so "when did they lose
 *     access" has an answer, which is the first question after an incident.
 */
public record ScimUser(
    UUID id,
    String email,
    String displayName,
    String externalId,
    Instant deactivatedAt,
    Instant createdAt) {

    public boolean active() {
        return deactivatedAt == null;
    }
}
