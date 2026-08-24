package com.switchboard.domain.access;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Reads the role model and resolves effective permissions. */
public interface AccessRepository {

    /**
     * The caller's effective permissions at one scope, as the UNION of what they
     * are granted at that scope and at every wider scope containing it.
     *
     * <p>Empty when the scope does not exist. Present with an empty permission set
     * when the scope exists but the caller has no standing in its org.
     */
    Mono<ResolvedAccess> resolve(UUID userId, AccessScope scope);

    /** Every role with its permission set, ordered by key. */
    Flux<RoleDefinition> listRoles();

    Mono<RoleDefinition> findRole(String roleKey);

    /**
     * Assignments anywhere under one org: ORG scope on the org itself, plus every
     * project and environment belonging to it. Both filters are optional.
     */
    Flux<RoleAssignment> listAssignments(UUID orgId, ScopeType scopeType, UUID scopeId);

    Mono<RoleAssignment> findAssignment(UUID assignmentId);

    /** Upsert on (user, scope): re-granting at the same scope replaces the role. */
    Mono<RoleAssignment> grant(UUID userId, AccessScope scope, String roleKey, String createdBy);

    /** Emits the number of rows deleted (0 = already gone). */
    Mono<Long> revoke(UUID assignmentId);

    /** Drops whatever role the user holds at exactly this scope; 0 when they hold none. */
    Mono<Long> revokeAtScope(UUID userId, AccessScope scope);

    /** The org a scope belongs to, or empty when the scope does not exist. */
    Mono<UUID> orgOfScope(AccessScope scope);
}
