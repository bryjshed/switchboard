package com.switchboard.domain.access;

import java.time.Instant;
import java.util.UUID;

/** One {@code role_assignments} row, resolved with the assignee's email. */
public record RoleAssignment(
    UUID id,
    UUID userId,
    String userEmail,
    ScopeType scopeType,
    UUID scopeId,
    String roleKey,
    Instant createdAt,
    String createdBy) {
}
