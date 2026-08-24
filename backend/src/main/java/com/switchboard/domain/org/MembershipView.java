package com.switchboard.domain.org;

import java.util.UUID;

/** Read model: one org membership row resolved with org display fields. */
public record MembershipView(UUID orgId, String orgName, String orgSlug, String role) {
}
