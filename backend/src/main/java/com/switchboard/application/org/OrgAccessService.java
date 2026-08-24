package com.switchboard.application.org;

import com.switchboard.domain.access.AccessRepository;
import com.switchboard.domain.access.AccessScope;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.access.ResolvedAccess;
import com.switchboard.domain.access.ScopeType;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.org.EnvironmentAccess;
import com.switchboard.domain.org.ProjectAccess;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * The single authorization gate. Every controller and application service funnels
 * through here, and since V2 every decision is a permission check: a caller may
 * act when the union of the roles they hold at the scope and at every scope
 * containing it grants the permission the operation needs.
 *
 * <p>The {@code requireXMember} methods are kept as the read gate. They now mean
 * "holds FLAG_READ here", which every built-in role does, so they behave exactly
 * as the old membership check did. The {@code requireXOwner} methods are gone:
 * what they really guarded was member management, key management, or org
 * settings, and each call site now names the permission it needs.
 *
 * <p>Error shapes are unchanged. A nonexistent org is 403 (existence is never
 * leaked); a nonexistent project or environment is 404; a caller with no standing
 * in the org is 403; a member missing the permission is 403.
 */
@Service
public class OrgAccessService {

    private static final String OWNER = "OWNER";
    private static final String MEMBER = "MEMBER";

    private final AccessRepository accessRepository;

    public OrgAccessService(AccessRepository accessRepository) {
        this.accessRepository = accessRepository;
    }

    // ---------------------------------------------------------------- permissions

    /**
     * Resolves the caller's access at one scope and asserts one permission,
     * emitting the resolved access record so the caller can reuse the topology it
     * already had to look up.
     */
    public Mono<ResolvedAccess> requirePermission(UUID userId, Permission permission, AccessScope scope) {
        return accessRepository.resolve(userId, scope)
            .switchIfEmpty(Mono.error(missingScope(scope.type())))
            .flatMap(access -> {
                if (access.isStranger()) {
                    return Mono.error(new ForbiddenException("Not a member of this org"));
                }
                if (!access.has(permission)) {
                    return Mono.error(new ForbiddenException(
                        "Requires the " + permission.name() + " permission"));
                }
                return Mono.just(access);
            });
    }

    /**
     * Everything the caller may do at one scope. A caller with no standing there
     * is refused rather than handed an empty list, so this endpoint leaks no more
     * about what exists than any other. This is the read model behind the "my
     * permissions" endpoint.
     */
    public Mono<Set<Permission>> permissionsAt(UUID userId, AccessScope scope) {
        return accessRepository.resolve(userId, scope)
            .switchIfEmpty(Mono.error(missingScope(scope.type())))
            .flatMap(access -> access.isStranger()
                ? Mono.error(new ForbiddenException("Not a member of this org"))
                : Mono.just(access.permissions()));
    }

    public Mono<String> requireOrgPermission(UUID orgId, UUID userId, Permission permission) {
        return requirePermission(userId, permission, AccessScope.org(orgId))
            .map(OrgAccessService::legacyRole);
    }

    public Mono<ProjectAccess> requireProjectPermission(UUID projectId, UUID userId, Permission permission) {
        return requirePermission(userId, permission, AccessScope.project(projectId))
            .map(access -> new ProjectAccess(access.projectId(), access.orgId(), legacyRole(access)));
    }

    public Mono<EnvironmentAccess> requireEnvironmentPermission(
        UUID environmentId, UUID userId, Permission permission) {
        return requirePermission(userId, permission, AccessScope.environment(environmentId))
            .map(access -> new EnvironmentAccess(
                access.environmentId(), access.environmentKey(),
                access.projectId(), access.orgId(), legacyRole(access)));
    }

    // ---------------------------------------------------------------- read gates

    /** Emits the caller's org role, or errors ForbiddenException when they have no standing. */
    public Mono<String> requireMember(UUID orgId, UUID userId) {
        return requireOrgPermission(orgId, userId, Permission.FLAG_READ);
    }

    /** Resolves project -> org access in one query. */
    public Mono<ProjectAccess> requireProjectMember(UUID projectId, UUID userId) {
        return requireProjectPermission(projectId, userId, Permission.FLAG_READ);
    }

    /** Resolves environment -> project -> org access in one query. */
    public Mono<EnvironmentAccess> requireEnvironmentMember(UUID environmentId, UUID userId) {
        return requireEnvironmentPermission(environmentId, userId, Permission.FLAG_READ);
    }

    // ---------------------------------------------------------------- plumbing

    private static RuntimeException missingScope(ScopeType type) {
        return switch (type) {
            // An org the caller cannot see is indistinguishable from one that is not there.
            case ORG -> new ForbiddenException("Not a member of this org");
            case PROJECT -> new NotFoundException("Project not found");
            case ENVIRONMENT -> new NotFoundException("Environment not found");
        };
    }

    /**
     * The OWNER/MEMBER string that responses have always carried. It comes from
     * {@code org_memberships} when there is a membership row; a caller who reached
     * this scope purely through a scoped role assignment has none, so it is
     * derived from what they can actually do.
     */
    private static String legacyRole(ResolvedAccess access) {
        if (access.orgRole() != null) {
            return access.orgRole();
        }
        return access.has(Permission.MANAGE_SETTINGS) ? OWNER : MEMBER;
    }
}
