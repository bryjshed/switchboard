package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.project.ApprovalSettings;
import com.switchboard.domain.project.Environment;
import com.switchboard.domain.project.EnvironmentRepository;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
public class EnvironmentRepositoryAdapter implements EnvironmentRepository {

    private final DatabaseClient db;

    public EnvironmentRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    private static Environment map(Readable row) {
        return new Environment(
            row.get("id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("key", String.class),
            row.get("name", String.class),
            row.get("state_version", Long.class),
            new ApprovalSettings(
                Boolean.TRUE.equals(row.get("require_approval", Boolean.class)),
                row.get("min_approvals", Integer.class),
                Boolean.TRUE.equals(row.get("allow_self_approval", Boolean.class)),
                Boolean.TRUE.equals(row.get("require_approval_for_kill", Boolean.class)),
                Boolean.TRUE.equals(row.get("allow_automation_bypass", Boolean.class))),
            row.get("created_at", Instant.class),
            row.get("archived_at", Instant.class));
    }

    @Override
    public Mono<Environment> create(UUID projectId, String key, String name) {
        return db.sql("INSERT INTO environments (project_id, key, name) VALUES (:projectId, :key, :name) RETURNING *")
            .bind("projectId", projectId)
            .bind("key", key)
            .bind("name", name)
            .map(EnvironmentRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<Environment> rename(UUID environmentId, String name) {
        return db.sql("UPDATE environments SET name = :name WHERE id = :id RETURNING *")
            .bind("id", environmentId)
            .bind("name", name)
            .map(EnvironmentRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<Environment> setArchived(UUID environmentId, boolean archived) {
        return db.sql("UPDATE environments SET archived_at = "
                + (archived ? "now()" : "NULL")
                + " WHERE id = :id RETURNING *")
            .bind("id", environmentId)
            .map(EnvironmentRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<Long> countActive(UUID projectId) {
        return db.sql("SELECT count(*) FROM environments "
                + "WHERE project_id = :projectId AND archived_at IS NULL")
            .bind("projectId", projectId)
            .map(row -> row.get(0, Long.class))
            .one();
    }

    /** Rewrites the approval policy and returns the updated row. */
    @Override
    public Mono<Environment> updateApprovalSettings(UUID environmentId, ApprovalSettings settings) {
        return db.sql("""
                UPDATE environments
                SET require_approval = :requireApproval,
                    min_approvals = :minApprovals,
                    allow_self_approval = :allowSelfApproval,
                    require_approval_for_kill = :requireApprovalForKill,
                    allow_automation_bypass = :allowAutomationBypass
                WHERE id = :id
                RETURNING *
                """)
            .bind("id", environmentId)
            .bind("requireApproval", settings.requireApproval())
            .bind("minApprovals", settings.minApprovals())
            .bind("allowSelfApproval", settings.allowSelfApproval())
            .bind("requireApprovalForKill", settings.requireApprovalForKill())
            .bind("allowAutomationBypass", settings.allowAutomationBypass())
            .map(EnvironmentRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<Environment> findById(UUID environmentId) {
        return db.sql("SELECT * FROM environments WHERE id = :id")
            .bind("id", environmentId)
            .map(EnvironmentRepositoryAdapter::map)
            .one();
    }

    @Override
    public Flux<Environment> findByProject(UUID projectId) {
        return db.sql("SELECT * FROM environments WHERE project_id = :projectId ORDER BY created_at, key")
            .bind("projectId", projectId)
            .map(EnvironmentRepositoryAdapter::map)
            .all();
    }

    @Override
    public Mono<Environment> findByProjectAndKey(UUID projectId, String key) {
        return db.sql("SELECT * FROM environments WHERE project_id = :projectId AND key = :key")
            .bind("projectId", projectId)
            .bind("key", key)
            .map(EnvironmentRepositoryAdapter::map)
            .one();
    }

    @Override
    public Flux<Environment> findByOrg(UUID orgId) {
        return db.sql("""
                SELECT e.* FROM environments e
                JOIN projects p ON p.id = e.project_id
                WHERE p.org_id = :orgId
                ORDER BY e.created_at, e.key
                """)
            .bind("orgId", orgId)
            .map(EnvironmentRepositoryAdapter::map)
            .all();
    }
}
