package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.project.Project;
import com.switchboard.domain.project.ProjectRepository;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
public class ProjectRepositoryAdapter implements ProjectRepository {

    private final DatabaseClient db;

    public ProjectRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    private static Project map(Readable row) {
        return new Project(
            row.get("id", UUID.class),
            row.get("org_id", UUID.class),
            row.get("key", String.class),
            row.get("name", String.class),
            row.get("created_at", Instant.class));
    }

    @Override
    public Mono<Project> create(UUID orgId, String key, String name) {
        return db.sql("INSERT INTO projects (org_id, key, name) VALUES (:orgId, :key, :name) RETURNING *")
            .bind("orgId", orgId)
            .bind("key", key)
            .bind("name", name)
            .map(ProjectRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<Project> findById(UUID projectId) {
        return db.sql("SELECT * FROM projects WHERE id = :id")
            .bind("id", projectId)
            .map(ProjectRepositoryAdapter::map)
            .one();
    }

    @Override
    public Flux<Project> findByOrg(UUID orgId) {
        return db.sql("SELECT * FROM projects WHERE org_id = :orgId ORDER BY created_at")
            .bind("orgId", orgId)
            .map(ProjectRepositoryAdapter::map)
            .all();
    }

    @Override
    public Mono<Project> updateName(UUID projectId, String name) {
        return db.sql("UPDATE projects SET name = :name WHERE id = :id RETURNING *")
            .bind("name", name)
            .bind("id", projectId)
            .map(ProjectRepositoryAdapter::map)
            .one();
    }
}
