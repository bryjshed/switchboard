package com.switchboard.domain.access;

import com.switchboard.domain.org.EnvironmentAccess;
import com.switchboard.domain.org.ProjectAccess;
import java.util.Set;
import java.util.UUID;

/**
 * The answer to one authorization question: which topology the scope resolves to,
 * the caller's legacy org-membership role (kept so existing responses keep
 * reporting OWNER/MEMBER), and the union of permissions they hold there.
 *
 * <p>{@code projectId} and {@code environmentId} are null when the question was
 * asked at a wider scope than they describe.
 */
public record ResolvedAccess(
    UUID orgId,
    UUID projectId,
    UUID environmentId,
    String environmentKey,
    String orgRole,
    Set<Permission> permissions) {

    public ResolvedAccess {
        permissions = permissions == null ? Set.of() : Set.copyOf(permissions);
    }

    public boolean has(Permission permission) {
        return permissions.contains(permission);
    }

    /** True when the caller has no standing in the org at all. */
    public boolean isStranger() {
        return permissions.isEmpty();
    }

    public ProjectAccess toProjectAccess() {
        return new ProjectAccess(projectId, orgId, orgRole);
    }

    public EnvironmentAccess toEnvironmentAccess() {
        return new EnvironmentAccess(environmentId, environmentKey, projectId, orgId, orgRole);
    }
}
