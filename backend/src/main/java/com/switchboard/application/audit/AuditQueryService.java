package com.switchboard.application.audit;

import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.project.EnvironmentRepository;
import io.r2dbc.spi.Readable;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * Audit feed reads with keyset pagination on (created_at, id) descending.
 * The cursor encodes the last row's created_at + id.
 */
@Service
public class AuditQueryService {

    private final DatabaseClient db;
    private final OrgAccessService access;
    private final EnvironmentRepository environments;

    public AuditQueryService(DatabaseClient db, OrgAccessService access, EnvironmentRepository environments) {
        this.db = db;
        this.access = access;
        this.environments = environments;
    }

    public Mono<AuditPage> listProject(
        UUID projectId, UUID userId, String envKey, String flagKey, String cursor, int limit) {
        Cursor after = Cursor.decode(cursor);
        return access.requireProjectPermission(projectId, userId, Permission.VIEW_AUDIT)
            .flatMap(projectAccess -> resolveEnvId(projectId, envKey)
                .flatMap(envId -> query(
                    "a.project_id = :scopeId", projectId,
                    envId.orElseNull(), flagKey, after, limit)));
    }

    public Mono<AuditPage> listOrg(UUID orgId, UUID userId, String cursor, int limit) {
        Cursor after = Cursor.decode(cursor);
        return access.requireOrgPermission(orgId, userId, Permission.VIEW_AUDIT)
            .flatMap(role -> query("a.org_id = :scopeId", orgId, null, null, after, limit));
    }

    private Mono<AuditPage> query(
        String scopePredicate, UUID scopeId, UUID envId, String flagKey, Cursor after, int limit) {

        StringBuilder sql = new StringBuilder("""
            SELECT a.*, e.key AS env_key
            FROM audit_entries a
            LEFT JOIN environments e ON e.id = a.environment_id
            WHERE %s
            """.formatted(scopePredicate));
        if (envId != null) {
            sql.append(" AND a.environment_id = :envId");
        }
        if (flagKey != null && !flagKey.isBlank()) {
            sql.append(" AND a.flag_key = :flagKey");
        }
        if (after != null) {
            sql.append(" AND (a.created_at, a.id) < (:afterCreatedAt, :afterId)");
        }
        sql.append(" ORDER BY a.created_at DESC, a.id DESC LIMIT :limit");

        DatabaseClient.GenericExecuteSpec spec = db.sql(sql.toString())
            .bind("scopeId", scopeId)
            .bind("limit", limit);
        if (envId != null) {
            spec = spec.bind("envId", envId);
        }
        if (flagKey != null && !flagKey.isBlank()) {
            spec = spec.bind("flagKey", flagKey);
        }
        if (after != null) {
            spec = spec.bind("afterCreatedAt", after.createdAt()).bind("afterId", after.id());
        }
        return spec.map(AuditQueryService::map)
            .all()
            .collectList()
            .map(items -> new AuditPage(
                items,
                items.size() == limit ? Cursor.encode(items.get(items.size() - 1)) : null));
    }

    /** Wraps the nullable env id so an empty filter and "no filter" both flow through flatMap. */
    private record OptionalEnv(UUID id) {
        UUID orElseNull() {
            return id;
        }
    }

    private Mono<OptionalEnv> resolveEnvId(UUID projectId, String envKey) {
        if (envKey == null || envKey.isBlank()) {
            return Mono.just(new OptionalEnv(null));
        }
        return environments.findByProject(projectId)
            .filter(env -> env.key().equals(envKey))
            .next()
            .map(env -> new OptionalEnv(env.id()))
            .switchIfEmpty(Mono.error(new NotFoundException("Environment not found")));
    }

    private static AuditEntry map(Readable row) {
        return new AuditEntry(
            row.get("id", UUID.class),
            row.get("org_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("environment_id", UUID.class),
            row.get("env_key", String.class),
            row.get("flag_key", String.class),
            row.get("action", String.class),
            row.get("actor", String.class),
            row.get("reason", String.class),
            row.get("version_from", Integer.class),
            row.get("version_to", Integer.class),
            row.get("created_at", Instant.class));
    }

    private record Cursor(Instant createdAt, UUID id) {

        static String encode(AuditEntry last) {
            String raw = last.createdAt() + "|" + last.id();
            return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
        }

        static Cursor decode(String cursor) {
            if (cursor == null || cursor.isBlank()) {
                return null;
            }
            try {
                String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
                List<String> parts = List.of(raw.split("\\|", 2));
                return new Cursor(Instant.parse(parts.get(0)), UUID.fromString(parts.get(1)));
            } catch (RuntimeException e) {
                throw new ValidationException("Malformed cursor");
            }
        }
    }
}
