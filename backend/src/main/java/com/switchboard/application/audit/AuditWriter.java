package com.switchboard.application.audit;

import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * Writes audit_entries rows. Scope columns (projectId, environmentId, flagKey)
 * and change metadata (reason, versions, diff) accept nulls.
 */
@Service
public class AuditWriter {

    private final DatabaseClient db;

    public AuditWriter(DatabaseClient db) {
        this.db = db;
    }

    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<Void> insert(
        UUID orgId,
        UUID projectId,
        UUID environmentId,
        String flagKey,
        String action,
        String actor,
        String reason,
        Integer versionFrom,
        Integer versionTo,
        String diffJson) {

        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                INSERT INTO audit_entries
                    (org_id, project_id, environment_id, flag_key, action, actor,
                     reason, version_from, version_to, diff)
                VALUES (:orgId, :projectId, :environmentId, :flagKey, :action, :actor,
                        :reason, :versionFrom, :versionTo, CAST(:diff AS jsonb))
                """)
            .bind("orgId", orgId)
            .bind("action", action)
            .bind("actor", actor);
        spec = bindNullable(spec, "projectId", projectId, UUID.class);
        spec = bindNullable(spec, "environmentId", environmentId, UUID.class);
        spec = bindNullable(spec, "flagKey", flagKey, String.class);
        spec = bindNullable(spec, "reason", reason, String.class);
        spec = bindNullable(spec, "versionFrom", versionFrom, Integer.class);
        spec = bindNullable(spec, "versionTo", versionTo, Integer.class);
        spec = bindNullable(spec, "diff", diffJson, String.class);
        return spec.then();
    }

    private static DatabaseClient.GenericExecuteSpec bindNullable(
        DatabaseClient.GenericExecuteSpec spec, String name, Object value, Class<?> type) {
        return value == null ? spec.bindNull(name, type) : spec.bind(name, value);
    }
}
