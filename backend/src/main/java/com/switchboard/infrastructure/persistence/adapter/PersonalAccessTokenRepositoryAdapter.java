package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.token.PersonalAccessToken;
import com.switchboard.domain.token.PersonalAccessTokenRepository;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
public class PersonalAccessTokenRepositoryAdapter implements PersonalAccessTokenRepository {

    private static final String COLUMNS =
        "id, user_id, name, token_prefix, expires_at, last_used_at, created_at, revoked_at";

    private final DatabaseClient db;

    public PersonalAccessTokenRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Mono<PersonalAccessToken> create(
        UUID userId, String name, String tokenPrefix, String tokenHash, Instant expiresAt) {

        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                INSERT INTO personal_access_tokens
                    (user_id, name, token_prefix, token_hash, expires_at)
                VALUES (:userId, :name, :tokenPrefix, :tokenHash, :expiresAt)
                RETURNING
                """ + COLUMNS)
            .bind("userId", userId)
            .bind("name", name)
            .bind("tokenPrefix", tokenPrefix)
            .bind("tokenHash", tokenHash);
        spec = expiresAt == null
            ? spec.bindNull("expiresAt", Instant.class)
            : spec.bind("expiresAt", expiresAt);
        return spec.map(PersonalAccessTokenRepositoryAdapter::map).one();
    }

    @Override
    public Flux<PersonalAccessToken> findByUser(UUID userId) {
        return db.sql("SELECT " + COLUMNS
                + " FROM personal_access_tokens WHERE user_id = :userId ORDER BY created_at DESC")
            .bind("userId", userId)
            .map(PersonalAccessTokenRepositoryAdapter::map)
            .all();
    }

    @Override
    public Mono<PersonalAccessToken> findById(UUID tokenId) {
        return db.sql("SELECT " + COLUMNS + " FROM personal_access_tokens WHERE id = :id")
            .bind("id", tokenId)
            .map(PersonalAccessTokenRepositoryAdapter::map)
            .one();
    }

    /**
     * The auth path's query. Revoked and expired are filtered in SQL rather than in Java so an
     * unusable token is simply not found - there is no window in which a caller holds a token
     * object it is not allowed to use.
     */
    @Override
    public Mono<UUID> findUsableUserIdByHash(String tokenHash, Instant now) {
        return db.sql("""
                SELECT user_id FROM personal_access_tokens
                WHERE token_hash = :hash
                  AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > :now)
                """)
            .bind("hash", tokenHash)
            .bind("now", now)
            .map(row -> row.get("user_id", UUID.class))
            .one();
    }

    @Override
    public Mono<PersonalAccessToken> revoke(UUID tokenId) {
        return db.sql("""
                UPDATE personal_access_tokens SET revoked_at = now()
                WHERE id = :id AND revoked_at IS NULL
                RETURNING
                """ + COLUMNS)
            .bind("id", tokenId)
            .map(PersonalAccessTokenRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<Void> touchLastUsed(String tokenHash, Instant now) {
        return db.sql("""
                UPDATE personal_access_tokens SET last_used_at = :now
                WHERE token_hash = :hash AND revoked_at IS NULL
                """)
            .bind("hash", tokenHash)
            .bind("now", now)
            .then();
    }

    private static PersonalAccessToken map(Readable row) {
        return new PersonalAccessToken(
            row.get("id", UUID.class),
            row.get("user_id", UUID.class),
            row.get("name", String.class),
            row.get("token_prefix", String.class),
            row.get("expires_at", Instant.class),
            row.get("last_used_at", Instant.class),
            row.get("created_at", Instant.class),
            row.get("revoked_at", Instant.class));
    }
}
