package com.switchboard.domain.org;

import java.time.Instant;
import java.util.UUID;

/** Read model: one org membership joined with the member's user fields. */
public record OrgMemberView(UUID userId, String email, String displayName, String role, Instant joinedAt) {
}
