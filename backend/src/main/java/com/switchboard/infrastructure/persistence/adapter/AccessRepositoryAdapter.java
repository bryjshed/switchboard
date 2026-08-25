package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.access.AccessRepository;
import com.switchboard.domain.access.AccessScope;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.access.ResolvedAccess;
import com.switchboard.domain.access.RoleAssignment;
import com.switchboard.domain.access.RoleDefinition;
import com.switchboard.domain.access.ScopeType;
import com.switchboard.infrastructure.config.MetricsConfig;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Permission resolution in one query per authorization question.
 *
 * <p><b>Union, not most-specific-wins.</b> A user's effective permissions at an
 * environment are the union of what they hold at that environment, at its
 * project, and at its org. A scoped grant therefore only ever adds capability.
 * Most-specific-wins was rejected: it would mean that giving somebody APPROVER on
 * production silently strips the flag-write they already had org-wide, which is
 * both surprising and a backwards-compatibility break the moment any scoped role
 * is granted. The cost of the choice is that permissions cannot be subtracted at
 * a narrower scope; to take capability away, lower the wider grant.
 *
 * <p>Containment runs one way only. An environment-scoped grant is authority
 * inside that environment and nowhere else - it does not roll up into
 * project-wide or org-wide read, or somebody given VIEWER on dev would be able to
 * read production. Give a reviewer a project or org role alongside their
 * environment role when they need the project surface too.
 *
 * <p>The legacy {@code org_memberships.role} is folded in as a compatibility
 * floor alongside {@code role_assignments}. V2 backfilled one into the other, so
 * in practice they agree; keeping the floor means a membership written by any
 * other path still resolves, and because the rule is union, an extra copy of the
 * same grant changes nothing.
 */
@Repository
public class AccessRepositoryAdapter implements AccessRepository {

    /**
     * The role keys that count at a scope: the caller's legacy membership role,
     * plus every role assigned at one of the scopes containing this one. The
     * {@code :userId} bind and the correlated scope columns are supplied by the
     * per-scope query that embeds this.
     */
    private static final String GRANTED_ROLE_KEYS = """
        SELECT m2.role AS role_key
        FROM org_memberships m2
        WHERE m2.org_id = %s AND m2.user_id = :userId
        UNION
        SELECT ra.role_key
        FROM role_assignments ra
        WHERE ra.user_id = :userId AND (%s)
        """;

    private final DatabaseClient db;
    private final Timer resolveTimer;

    public AccessRepositoryAdapter(DatabaseClient db, MeterRegistry meters) {
        this.db = db;
        this.resolveTimer = Timer.builder(MetricsConfig.PERMISSION_RESOLVE_TIMER)
            .description("Resolving a user's permissions at one scope, unioned across org/project/env")
            .register(meters);
    }

    /**
     * Timed and tagged by scope type: this runs once per authorization decision and a single
     * dashboard page load makes several, so the count is what says whether caching per
     * (user, scope) is worth doing.
     */
    @Override
    public Mono<ResolvedAccess> resolve(UUID userId, AccessScope scope) {
        return Mono.defer(() -> {
            long startedAt = System.nanoTime();
            return db.sql(resolveSql(scope.type()))
                .bind("userId", userId)
                .bind("scopeId", scope.id())
                .map(AccessRepositoryAdapter::mapAccessRow)
                .all()
                .collectList()
                .doFinally(signal -> resolveTimer.record(
                    System.nanoTime() - startedAt, TimeUnit.NANOSECONDS))
                .flatMap(rows -> rows.isEmpty() ? Mono.empty() : Mono.just(fold(rows)));
        });
    }

    /**
     * One row per granted permission, or a single row with a null permission when
     * the caller holds none. The scope row itself always exists or the query
     * returns nothing at all, which is how a missing scope is told apart from a
     * caller with no standing in it.
     */
    private static String resolveSql(ScopeType type) {
        return switch (type) {
            case ORG -> """
                SELECT o.id AS org_id, NULL::uuid AS project_id, NULL::uuid AS environment_id,
                       NULL AS environment_key, m.role AS org_role, perms.permission
                FROM orgs o
                LEFT JOIN org_memberships m ON m.org_id = o.id AND m.user_id = :userId
                LEFT JOIN LATERAL (
                    SELECT DISTINCT rp.permission
                    FROM role_permissions rp
                    WHERE rp.role_key IN (%s)
                ) perms ON TRUE
                WHERE o.id = :scopeId
                """.formatted(GRANTED_ROLE_KEYS.formatted(
                    "o.id", "ra.scope_type = 'ORG' AND ra.scope_id = o.id"));
            case PROJECT -> """
                SELECT p.org_id, p.id AS project_id, NULL::uuid AS environment_id,
                       NULL AS environment_key, m.role AS org_role, perms.permission
                FROM projects p
                LEFT JOIN org_memberships m ON m.org_id = p.org_id AND m.user_id = :userId
                LEFT JOIN LATERAL (
                    SELECT DISTINCT rp.permission
                    FROM role_permissions rp
                    WHERE rp.role_key IN (%s)
                ) perms ON TRUE
                WHERE p.id = :scopeId
                """.formatted(GRANTED_ROLE_KEYS.formatted("p.org_id", """
                    (ra.scope_type = 'ORG' AND ra.scope_id = p.org_id)
                    OR (ra.scope_type = 'PROJECT' AND ra.scope_id = p.id)"""));
            case ENVIRONMENT -> """
                SELECT p.org_id, p.id AS project_id, e.id AS environment_id,
                       e.key AS environment_key, m.role AS org_role, perms.permission
                FROM environments e
                JOIN projects p ON p.id = e.project_id
                LEFT JOIN org_memberships m ON m.org_id = p.org_id AND m.user_id = :userId
                LEFT JOIN LATERAL (
                    SELECT DISTINCT rp.permission
                    FROM role_permissions rp
                    WHERE rp.role_key IN (%s)
                ) perms ON TRUE
                WHERE e.id = :scopeId
                """.formatted(GRANTED_ROLE_KEYS.formatted("p.org_id", """
                    (ra.scope_type = 'ORG' AND ra.scope_id = p.org_id)
                    OR (ra.scope_type = 'PROJECT' AND ra.scope_id = p.id)
                    OR (ra.scope_type = 'ENVIRONMENT' AND ra.scope_id = e.id)"""));
        };
    }

    private record AccessRow(
        UUID orgId, UUID projectId, UUID environmentId, String environmentKey,
        String orgRole, String permission) {
    }

    private static AccessRow mapAccessRow(Readable row) {
        return new AccessRow(
            row.get("org_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("environment_id", UUID.class),
            row.get("environment_key", String.class),
            row.get("org_role", String.class),
            row.get("permission", String.class));
    }

    private static ResolvedAccess fold(List<AccessRow> rows) {
        AccessRow first = rows.get(0);
        Set<Permission> permissions = new LinkedHashSet<>();
        for (AccessRow row : rows) {
            Permission permission = Permission.parseOrNull(row.permission());
            if (permission != null) {
                permissions.add(permission);
            }
        }
        return new ResolvedAccess(
            first.orgId(), first.projectId(), first.environmentId(),
            first.environmentKey(), first.orgRole(), permissions);
    }

    // ---------------------------------------------------------------- roles

    @Override
    public Flux<RoleDefinition> listRoles() {
        return db.sql("""
                SELECT r.key, r.name, r.description, r.built_in,
                       coalesce(array_agg(rp.permission ORDER BY rp.permission)
                                FILTER (WHERE rp.permission IS NOT NULL), '{}'::text[]) AS permissions
                FROM roles r
                LEFT JOIN role_permissions rp ON rp.role_key = r.key
                GROUP BY r.key, r.name, r.description, r.built_in
                ORDER BY r.key
                """)
            .map(AccessRepositoryAdapter::mapRole)
            .all();
    }

    @Override
    public Mono<RoleDefinition> findRole(String roleKey) {
        return db.sql("""
                SELECT r.key, r.name, r.description, r.built_in,
                       coalesce(array_agg(rp.permission ORDER BY rp.permission)
                                FILTER (WHERE rp.permission IS NOT NULL), '{}'::text[]) AS permissions
                FROM roles r
                LEFT JOIN role_permissions rp ON rp.role_key = r.key
                WHERE r.key = :roleKey
                GROUP BY r.key, r.name, r.description, r.built_in
                """)
            .bind("roleKey", roleKey)
            .map(AccessRepositoryAdapter::mapRole)
            .one();
    }

    private static RoleDefinition mapRole(Readable row) {
        Set<Permission> permissions = new LinkedHashSet<>();
        for (String name : row.get("permissions", String[].class)) {
            Permission permission = Permission.parseOrNull(name);
            if (permission != null) {
                permissions.add(permission);
            }
        }
        return new RoleDefinition(
            row.get("key", String.class),
            row.get("name", String.class),
            row.get("description", String.class),
            Boolean.TRUE.equals(row.get("built_in", Boolean.class)),
            permissions);
    }

    // ---------------------------------------------------------------- assignments

    /** Every assignment row joined up to the org that contains its scope. */
    private static final String ASSIGNMENTS_IN_ORG = """
        SELECT ra.id, ra.user_id, u.email, ra.scope_type, ra.scope_id, ra.role_key,
               ra.created_at, ra.created_by
        FROM role_assignments ra
        JOIN users u ON u.id = ra.user_id
        LEFT JOIN projects sp ON ra.scope_type = 'PROJECT' AND sp.id = ra.scope_id
        LEFT JOIN environments se ON ra.scope_type = 'ENVIRONMENT' AND se.id = ra.scope_id
        LEFT JOIN projects sep ON sep.id = se.project_id
        WHERE ((ra.scope_type = 'ORG' AND ra.scope_id = :orgId)
               OR sp.org_id = :orgId OR sep.org_id = :orgId)
        """;

    @Override
    public Flux<RoleAssignment> listAssignments(UUID orgId, ScopeType scopeType, UUID scopeId) {
        StringBuilder sql = new StringBuilder(ASSIGNMENTS_IN_ORG);
        if (scopeType != null) {
            sql.append(" AND ra.scope_type = :scopeType");
        }
        if (scopeId != null) {
            sql.append(" AND ra.scope_id = :scopeId");
        }
        sql.append(" ORDER BY ra.created_at, ra.id");
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql.toString()).bind("orgId", orgId);
        if (scopeType != null) {
            spec = spec.bind("scopeType", scopeType.name());
        }
        if (scopeId != null) {
            spec = spec.bind("scopeId", scopeId);
        }
        return spec.map(AccessRepositoryAdapter::mapAssignment).all();
    }

    @Override
    public Mono<RoleAssignment> findAssignment(UUID assignmentId) {
        return db.sql("""
                SELECT ra.id, ra.user_id, u.email, ra.scope_type, ra.scope_id, ra.role_key,
                       ra.created_at, ra.created_by
                FROM role_assignments ra JOIN users u ON u.id = ra.user_id
                WHERE ra.id = :id
                """)
            .bind("id", assignmentId)
            .map(AccessRepositoryAdapter::mapAssignment)
            .one();
    }

    @Override
    public Mono<RoleAssignment> grant(UUID userId, AccessScope scope, String roleKey, String createdBy) {
        return db.sql("""
                WITH upserted AS (
                    INSERT INTO role_assignments (user_id, scope_type, scope_id, role_key, created_by)
                    VALUES (:userId, :scopeType, :scopeId, :roleKey, :createdBy)
                    ON CONFLICT (user_id, scope_type, scope_id)
                    DO UPDATE SET role_key = EXCLUDED.role_key,
                                  created_by = EXCLUDED.created_by,
                                  created_at = now()
                    RETURNING id, user_id, scope_type, scope_id, role_key, created_at, created_by
                )
                SELECT upserted.*, u.email FROM upserted JOIN users u ON u.id = upserted.user_id
                """)
            .bind("userId", userId)
            .bind("scopeType", scope.type().name())
            .bind("scopeId", scope.id())
            .bind("roleKey", roleKey)
            .bind("createdBy", createdBy)
            .map(AccessRepositoryAdapter::mapAssignment)
            .one();
    }

    @Override
    public Mono<Long> revoke(UUID assignmentId) {
        return db.sql("DELETE FROM role_assignments WHERE id = :id")
            .bind("id", assignmentId)
            .fetch()
            .rowsUpdated();
    }

    @Override
    public Mono<Long> revokeAtScope(UUID userId, AccessScope scope) {
        return db.sql("""
                DELETE FROM role_assignments
                WHERE user_id = :userId AND scope_type = :scopeType AND scope_id = :scopeId
                """)
            .bind("userId", userId)
            .bind("scopeType", scope.type().name())
            .bind("scopeId", scope.id())
            .fetch()
            .rowsUpdated();
    }

    @Override
    public Mono<UUID> orgOfScope(AccessScope scope) {
        String sql = switch (scope.type()) {
            case ORG -> "SELECT id AS org_id FROM orgs WHERE id = :scopeId";
            case PROJECT -> "SELECT org_id FROM projects WHERE id = :scopeId";
            case ENVIRONMENT -> """
                SELECT p.org_id FROM environments e JOIN projects p ON p.id = e.project_id
                WHERE e.id = :scopeId
                """;
        };
        return db.sql(sql)
            .bind("scopeId", scope.id())
            .map(row -> row.get("org_id", UUID.class))
            .one();
    }

    private static RoleAssignment mapAssignment(Readable row) {
        return new RoleAssignment(
            row.get("id", UUID.class),
            row.get("user_id", UUID.class),
            row.get("email", String.class),
            ScopeType.valueOf(row.get("scope_type", String.class)),
            row.get("scope_id", UUID.class),
            row.get("role_key", String.class),
            row.get("created_at", Instant.class),
            row.get("created_by", String.class));
    }
}
