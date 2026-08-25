package com.switchboard.application.access;

import com.switchboard.application.cache.CacheName;
import com.switchboard.infrastructure.notify.CacheInvalidationPublisher;
import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.AccessRepository;
import com.switchboard.domain.access.AccessScope;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.access.RoleAssignment;
import com.switchboard.domain.access.RoleDefinition;
import com.switchboard.domain.access.ScopeType;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserRepository;
import com.switchboard.interfaces.security.AuthenticatedUser;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * The admin surface over the role model: what roles exist, who holds what where,
 * and the caller's own effective permissions.
 *
 * <p>Granting and revoking need MANAGE_MEMBERS on the org, and the scope being
 * granted at must belong to that org - otherwise an org admin could hand
 * themselves a role inside somebody else's project by guessing an id.
 */
@Service
public class AccessAdminService {

    private final AccessRepository roles;
    private final OrgAccessService access;
    private final UserRepository users;
    private final AuditWriter audit;
    private final CacheInvalidationPublisher cacheInvalidation;
    private final TransactionalOperator tx;

    public AccessAdminService(
        AccessRepository roles,
        OrgAccessService access,
        UserRepository users,
        AuditWriter audit,
        CacheInvalidationPublisher cacheInvalidation,
        TransactionalOperator tx) {
        this.roles = roles;
        this.access = access;
        this.users = users;
        this.audit = audit;
        this.cacheInvalidation = cacheInvalidation;
        this.tx = tx;
    }

    /** The role catalogue is not org-specific and is readable by any signed-in user. */
    public Flux<RoleDefinition> listRoles() {
        return roles.listRoles();
    }

    public Flux<RoleAssignment> listAssignments(
        UUID orgId, UUID callerId, ScopeType scopeType, UUID scopeId) {
        return access.requireOrgPermission(orgId, callerId, Permission.MANAGE_MEMBERS)
            .thenMany(Flux.defer(() -> roles.listAssignments(orgId, scopeType, scopeId)));
    }

    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<RoleAssignment> grant(
        UUID orgId, AuthenticatedUser caller, UUID userId, String email,
        ScopeType scopeType, UUID scopeId, String roleKey) {

        AccessScope scope = new AccessScope(scopeType, scopeId);
        return access.requireOrgPermission(orgId, caller.userId(), Permission.MANAGE_MEMBERS)
            .then(requireRoleExists(roleKey))
            .then(requireScopeInOrg(orgId, scope))
            .then(resolveTarget(userId, email))
            .flatMap(target -> roles.grant(target.id(), scope, roleKey, caller.email())
                .flatMap(assignment -> audit.insert(
                        orgId, projectIdOf(scope), environmentIdOf(scope), null,
                        "ROLE_GRANT", caller.email(),
                        target.email() + " -> " + roleKey + " at " + scopeType + " " + scopeId,
                        null, null, null)
                    .thenReturn(assignment))
                .as(tx::transactional)
                // After commit. Clearing rather than evicting one key is deliberate: permissions
                // are a UNION across scopes, so a grant at org scope changes this user's answer at
                // every project and environment beneath it. There is no key to evict, only a
                // family - and role changes are rare enough that clearing a 30-second cache costs
                // a brief re-resolve, not a stampede.
                .doOnSuccess(ignored -> cacheInvalidation.evictAll(CacheName.PERMISSIONS)));
    }

    public Mono<Void> revoke(UUID orgId, AuthenticatedUser caller, UUID assignmentId) {
        return access.requireOrgPermission(orgId, caller.userId(), Permission.MANAGE_MEMBERS)
            .then(roles.findAssignment(assignmentId))
            .switchIfEmpty(Mono.error(new NotFoundException("Role assignment not found")))
            .flatMap(assignment -> {
                AccessScope scope = new AccessScope(assignment.scopeType(), assignment.scopeId());
                return requireScopeInOrg(orgId, scope)
                    .then(roles.revoke(assignmentId))
                    .then(audit.insert(
                        orgId, projectIdOf(scope), environmentIdOf(scope), null,
                        "ROLE_REVOKE", caller.email(),
                        assignment.userEmail() + " lost " + assignment.roleKey()
                            + " at " + assignment.scopeType() + " " + assignment.scopeId(),
                        null, null, null))
                    .as(tx::transactional)
                    // Revocation especially: a cached grant that outlives its revocation is the
                    // difference between taking access away and asking nicely.
                    .doOnSuccess(ignored -> cacheInvalidation.evictAll(CacheName.PERMISSIONS));
            });
    }

    /** The caller's own effective permissions, for a UI that hides what it cannot use. */
    public Mono<ScopedPermissions> permissionsOf(UUID userId, UUID orgId, UUID projectId, UUID envId) {
        AccessScope scope = narrowest(orgId, projectId, envId);
        return access.permissionsAt(userId, scope)
            .map(permissions -> new ScopedPermissions(scope, permissions));
    }

    /** A resolved scope with the permissions the caller holds there. */
    public record ScopedPermissions(AccessScope scope, Set<Permission> permissions) {
    }

    // ---------------------------------------------------------------- plumbing

    /** The narrowest scope the caller named: an environment beats a project beats an org. */
    private static AccessScope narrowest(UUID orgId, UUID projectId, UUID envId) {
        if (envId != null) {
            return AccessScope.environment(envId);
        }
        if (projectId != null) {
            return AccessScope.project(projectId);
        }
        if (orgId != null) {
            return AccessScope.org(orgId);
        }
        throw new ValidationException("Name a scope: orgId, projectId, or envId");
    }

    private Mono<Void> requireRoleExists(String roleKey) {
        return roles.findRole(roleKey)
            .switchIfEmpty(Mono.error(new ValidationException("Unknown role \"" + roleKey + "\"")))
            .then();
    }

    private Mono<Void> requireScopeInOrg(UUID orgId, AccessScope scope) {
        return roles.orgOfScope(scope)
            .switchIfEmpty(Mono.error(new NotFoundException("Scope not found")))
            .flatMap(owner -> owner.equals(orgId)
                ? Mono.empty()
                : Mono.error(new NotFoundException("Scope not found in this org")));
    }

    private Mono<User> resolveTarget(UUID userId, String email) {
        if (userId != null) {
            return users.findById(userId)
                .switchIfEmpty(Mono.error(new NotFoundException("No user with that id")));
        }
        if (email == null || email.isBlank()) {
            return Mono.error(new ValidationException("Name the user by userId or email"));
        }
        return users.findByEmailPreferringReal(email)
            .switchIfEmpty(Mono.error(new NotFoundException("No user with that email")));
    }

    private static UUID projectIdOf(AccessScope scope) {
        return scope.type() == ScopeType.PROJECT ? scope.id() : null;
    }

    private static UUID environmentIdOf(AccessScope scope) {
        return scope.type() == ScopeType.ENVIRONMENT ? scope.id() : null;
    }
}
