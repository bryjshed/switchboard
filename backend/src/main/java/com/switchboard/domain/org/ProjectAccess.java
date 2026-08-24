package com.switchboard.domain.org;

import java.util.UUID;

/**
 * Access-resolution read model: a project joined with the caller's org membership.
 * {@code role} is null when the caller is not a member of the owning org.
 */
public record ProjectAccess(UUID projectId, UUID orgId, String role) {
}
