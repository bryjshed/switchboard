package com.switchboard.domain.org;

import java.util.UUID;

/**
 * Access-resolution read model: an environment joined up to the owning org and
 * the caller's membership. {@code role} is null when the caller is not a member.
 */
public record EnvironmentAccess(UUID environmentId, String environmentKey, UUID projectId, UUID orgId, String role) {
}
