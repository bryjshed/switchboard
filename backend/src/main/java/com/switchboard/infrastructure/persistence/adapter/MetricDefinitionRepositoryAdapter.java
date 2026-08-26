package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.metric.MetricDefinition;
import com.switchboard.domain.metric.MetricDefinitionRepository;
import com.switchboard.domain.metric.MetricDirection;
import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** {@link MetricDefinitionRepository} over {@link DatabaseClient}. */
@Repository
public class MetricDefinitionRepositoryAdapter implements MetricDefinitionRepository {

    private static final String COLUMNS =
        "id, project_id, key, name, description, direction, tau, auto_act, created_at, updated_at";

    private final DatabaseClient db;

    public MetricDefinitionRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Flux<MetricDefinition> findByProject(UUID projectId) {
        return db.sql("SELECT " + COLUMNS + " FROM metric_definitions WHERE project_id = :projectId ORDER BY key")
            .bind("projectId", projectId)
            .map(MetricDefinitionRepositoryAdapter::map)
            .all();
    }

    @Override
    public Mono<MetricDefinition> findById(UUID id) {
        return db.sql("SELECT " + COLUMNS + " FROM metric_definitions WHERE id = :id")
            .bind("id", id)
            .map(MetricDefinitionRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<MetricDefinition> findByProjectAndKey(UUID projectId, String key) {
        return db.sql("SELECT " + COLUMNS
                + " FROM metric_definitions WHERE project_id = :projectId AND key = :key")
            .bind("projectId", projectId)
            .bind("key", key)
            .map(MetricDefinitionRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<MetricDefinition> create(MetricDefinition definition) {
        return db.sql("""
                INSERT INTO metric_definitions
                    (project_id, key, name, description, direction, tau, auto_act)
                VALUES (:projectId, :key, :name, :description, :direction, :tau, :autoAct)
                RETURNING
                """ + COLUMNS)
            .bind("projectId", definition.projectId())
            .bind("key", definition.key())
            .bind("name", definition.name())
            .bind("description", definition.description() == null ? "" : definition.description())
            .bind("direction", definition.direction().name())
            .bind("tau", definition.tau())
            .bind("autoAct", definition.autoAct())
            .map(MetricDefinitionRepositoryAdapter::map)
            .one();
    }

    /** Null means "leave alone"; the key is immutable because events already carry it. */
    @Override
    public Mono<MetricDefinition> update(UUID id, String name, String description,
        MetricDirection direction, Double tau, Boolean autoAct) {
        return db.sql("""
                UPDATE metric_definitions SET
                    name = COALESCE(:name, name),
                    description = COALESCE(:description, description),
                    direction = COALESCE(:direction, direction),
                    tau = COALESCE(:tau, tau),
                    auto_act = COALESCE(:autoAct, auto_act),
                    updated_at = now()
                WHERE id = :id
                RETURNING
                """ + COLUMNS)
            .bind("id", id)
            .bind("name", name == null ? Parameters.in(String.class) : name)
            .bind("description", description == null ? Parameters.in(String.class) : description)
            .bind("direction", direction == null ? Parameters.in(String.class) : direction.name())
            .bind("tau", tau == null ? Parameters.in(Double.class) : tau)
            .bind("autoAct", autoAct == null ? Parameters.in(Boolean.class) : autoAct)
            .map(MetricDefinitionRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<Void> delete(UUID id) {
        return db.sql("DELETE FROM metric_definitions WHERE id = :id").bind("id", id).then();
    }

    @Override
    public Mono<Void> seedDefaults(UUID projectId) {
        // ON CONFLICT DO NOTHING so this is safe to call more than once, and so a project
        // created concurrently with V10 cannot fail on the unique key.
        return db.sql("""
                INSERT INTO metric_definitions (project_id, key, name, description, direction, tau)
                VALUES
                    (:projectId, 'error', 'Errors',
                     'Subjects that hit at least one error.', 'DECREASE_IS_BETTER', 0.01),
                    (:projectId, 'conversion', 'Conversions',
                     'Subjects that converted at least once.', 'INCREASE_IS_BETTER', 0.02)
                ON CONFLICT (project_id, key) DO NOTHING
                """)
            .bind("projectId", projectId)
            .then();
    }

    private static MetricDefinition map(Readable row) {
        return new MetricDefinition(
            row.get("id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("key", String.class),
            row.get("name", String.class),
            row.get("description", String.class),
            MetricDirection.valueOf(row.get("direction", String.class)),
            row.get("tau", Double.class),
            Boolean.TRUE.equals(row.get("auto_act", Boolean.class)),
            row.get("created_at", Instant.class),
            row.get("updated_at", Instant.class));
    }
}
