package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.identity.Identities;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserIdentity;
import com.switchboard.domain.user.UserRepository;
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
public class UserRepositoryAdapter implements UserRepository {

    private final DatabaseClient db;

    public UserRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    private static User map(Readable row) {
        return new User(
            row.get("id", UUID.class),
            row.get("email", String.class),
            row.get("display_name", String.class),
            Boolean.TRUE.equals(row.get("onboarding_completed", Boolean.class)),
            row.get("deactivated_at", Instant.class) != null);
    }

    private static UserIdentity mapIdentity(Readable row) {
        return new UserIdentity(
            row.get("user_id", UUID.class),
            row.get("issuer", String.class),
            row.get("subject", String.class),
            row.get("linked_at", Instant.class));
    }

    @Override
    public Mono<User> findByIssuerAndSubject(String issuer, String subject) {
        return db.sql("""
                SELECT u.* FROM users u
                JOIN user_identities i ON i.user_id = u.id
                WHERE i.issuer = :issuer AND i.subject = :subject
                """)
            .bind("issuer", issuer)
            .bind("subject", subject)
            .map(UserRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<User> findById(UUID userId) {
        return db.sql("SELECT * FROM users WHERE id = :id")
            .bind("id", userId)
            .map(UserRepositoryAdapter::map)
            .one();
    }

    /**
     * A dev-provisioned row is a placeholder for someone who has not signed in yet, so a row
     * holding any real identity wins the tie. This is the generalisation of the old
     * {@code ORDER BY firebase_uid LIKE 'dev:%'}.
     */
    @Override
    public Mono<User> findByEmailPreferringReal(String email) {
        return db.sql("""
                SELECT u.* FROM users u
                WHERE u.email = :email
                ORDER BY EXISTS (
                    SELECT 1 FROM user_identities i
                    WHERE i.user_id = u.id AND i.issuer <> :devIssuer
                ) DESC, u.created_at
                LIMIT 1
                """)
            .bind("email", email)
            .bind("devIssuer", Identities.DEV_ISSUER)
            .map(UserRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<User> create(String email, String displayName) {
        return db.sql("INSERT INTO users (email, display_name) VALUES (:email, :name) RETURNING *")
            .bind("email", email)
            .bind("name", displayName == null ? Parameters.in(R2dbcType.VARCHAR) : displayName)
            .map(UserRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<UserIdentity> linkIdentity(UUID userId, String issuer, String subject) {
        return db.sql("""
                INSERT INTO user_identities (user_id, issuer, subject)
                VALUES (:userId, :issuer, :subject)
                RETURNING *
                """)
            .bind("userId", userId)
            .bind("issuer", issuer)
            .bind("subject", subject)
            .map(UserRepositoryAdapter::mapIdentity)
            .one();
    }

    @Override
    public Flux<UserIdentity> identitiesOf(UUID userId) {
        return db.sql("SELECT * FROM user_identities WHERE user_id = :userId ORDER BY linked_at")
            .bind("userId", userId)
            .map(UserRepositoryAdapter::mapIdentity)
            .all();
    }
}
