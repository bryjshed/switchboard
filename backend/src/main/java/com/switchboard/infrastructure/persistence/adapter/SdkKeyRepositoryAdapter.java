package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.project.SdkKey;
import com.switchboard.domain.project.SdkKeyKind;
import com.switchboard.domain.project.SdkKeyRepository;
import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.R2dbcType;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
public class SdkKeyRepositoryAdapter implements SdkKeyRepository {

    private final DatabaseClient db;

    public SdkKeyRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    private static SdkKey map(Readable row) {
        return new SdkKey(
            row.get("id", UUID.class),
            row.get("environment_id", UUID.class),
            SdkKeyKind.valueOf(row.get("kind", String.class)),
            row.get("key_prefix", String.class),
            row.get("label", String.class),
            row.get("created_by", String.class),
            row.get("created_at", Instant.class),
            row.get("revoked_at", Instant.class));
    }

    @Override
    public Mono<SdkKey> create(
        UUID environmentId, SdkKeyKind kind, String keyPrefix, String keyHash,
        String label, String createdBy) {
        return db.sql("""
                INSERT INTO sdk_keys (environment_id, kind, key_prefix, key_hash, label, created_by)
                VALUES (:environmentId, :kind, :keyPrefix, :keyHash, :label, :createdBy)
                RETURNING *
                """)
            .bind("environmentId", environmentId)
            .bind("kind", kind.name())
            .bind("keyPrefix", keyPrefix)
            .bind("keyHash", keyHash)
            .bind("label", label == null ? Parameters.in(R2dbcType.VARCHAR) : label)
            .bind("createdBy", createdBy)
            .map(SdkKeyRepositoryAdapter::map)
            .one();
    }

    @Override
    public Flux<SdkKey> findByEnvironment(UUID environmentId) {
        return db.sql("SELECT * FROM sdk_keys WHERE environment_id = :environmentId ORDER BY created_at")
            .bind("environmentId", environmentId)
            .map(SdkKeyRepositoryAdapter::map)
            .all();
    }

    @Override
    public Mono<SdkKey> findById(UUID keyId) {
        return db.sql("SELECT * FROM sdk_keys WHERE id = :id")
            .bind("id", keyId)
            .map(SdkKeyRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<String> findHashById(UUID keyId) {
        return db.sql("SELECT key_hash FROM sdk_keys WHERE id = :id")
            .bind("id", keyId)
            .map(row -> row.get("key_hash", String.class))
            .one();
    }

    @Override
    public Mono<SdkKey> revoke(UUID keyId) {
        return db.sql("UPDATE sdk_keys SET revoked_at = now() WHERE id = :id AND revoked_at IS NULL RETURNING *")
            .bind("id", keyId)
            .map(SdkKeyRepositoryAdapter::map)
            .one();
    }
}
