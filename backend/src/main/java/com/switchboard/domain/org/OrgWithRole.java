package com.switchboard.domain.org;

import java.time.Instant;
import java.util.UUID;

/** Read model: an org row joined with the caller's membership role. */
public record OrgWithRole(UUID id, String name, String slug, String role, Instant createdAt) {
}
