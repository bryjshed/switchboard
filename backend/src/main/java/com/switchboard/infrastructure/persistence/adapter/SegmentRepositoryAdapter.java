package com.switchboard.infrastructure.persistence.adapter;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.segment.Segment;
import com.switchboard.domain.segment.SegmentRepository;
import com.switchboard.domain.segment.SegmentRule;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
public class SegmentRepositoryAdapter implements SegmentRepository {

    private static final TypeReference<List<SegmentRule>> RULES_TYPE = new TypeReference<>() {
    };

    private final DatabaseClient db;
    private final ObjectMapper json;

    public SegmentRepositoryAdapter(DatabaseClient db, ObjectMapper json) {
        this.db = db;
        this.json = json;
    }

    @Override
    public Mono<Segment> insert(Segment segment) {
        return db.sql("""
                INSERT INTO segments (project_id, key, name, included_keys, excluded_keys, rules)
                VALUES (:projectId, :key, :name, :includedKeys, :excludedKeys, CAST(:rules AS jsonb))
                RETURNING *
                """)
            .bind("projectId", segment.projectId())
            .bind("key", segment.key())
            .bind("name", segment.name())
            .bind("includedKeys", segment.includedKeys().toArray(String[]::new))
            .bind("excludedKeys", segment.excludedKeys().toArray(String[]::new))
            .bind("rules", write(segment.rules()))
            .map(this::map)
            .one();
    }

    @Override
    public Mono<Segment> update(Segment segment) {
        return db.sql("""
                UPDATE segments
                SET name = :name, included_keys = :includedKeys, excluded_keys = :excludedKeys,
                    rules = CAST(:rules AS jsonb), updated_at = now()
                WHERE project_id = :projectId AND key = :key
                RETURNING *
                """)
            .bind("projectId", segment.projectId())
            .bind("key", segment.key())
            .bind("name", segment.name())
            .bind("includedKeys", segment.includedKeys().toArray(String[]::new))
            .bind("excludedKeys", segment.excludedKeys().toArray(String[]::new))
            .bind("rules", write(segment.rules()))
            .map(this::map)
            .one();
    }

    @Override
    public Mono<Long> delete(UUID projectId, String key) {
        return db.sql("DELETE FROM segments WHERE project_id = :projectId AND key = :key")
            .bind("projectId", projectId)
            .bind("key", key)
            .fetch()
            .rowsUpdated();
    }

    @Override
    public Mono<Segment> findByKey(UUID projectId, String key) {
        return db.sql("SELECT * FROM segments WHERE project_id = :projectId AND key = :key")
            .bind("projectId", projectId)
            .bind("key", key)
            .map(this::map)
            .one();
    }

    @Override
    public Flux<Segment> findByProject(UUID projectId) {
        return db.sql("SELECT * FROM segments WHERE project_id = :projectId ORDER BY key")
            .bind("projectId", projectId)
            .map(this::map)
            .all();
    }

    private Segment map(Readable row) {
        return new Segment(
            row.get("id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("key", String.class),
            row.get("name", String.class),
            List.of(row.get("included_keys", String[].class)),
            List.of(row.get("excluded_keys", String[].class)),
            readRules(row.get("rules", String.class)),
            row.get("updated_at", Instant.class));
    }

    private String write(List<SegmentRule> rules) {
        try {
            return json.writeValueAsString(rules);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize segment rules", e);
        }
    }

    private List<SegmentRule> readRules(String raw) {
        try {
            return json.readValue(raw, RULES_TYPE);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to deserialize segment rules", e);
        }
    }
}
