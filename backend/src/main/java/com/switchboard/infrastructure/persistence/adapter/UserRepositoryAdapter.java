package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserRepository;
import io.r2dbc.spi.Readable;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
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
            row.get("firebase_uid", String.class),
            row.get("email", String.class),
            row.get("display_name", String.class),
            Boolean.TRUE.equals(row.get("onboarding_completed", Boolean.class)));
    }

    @Override
    public Mono<User> findByFirebaseUid(String firebaseUid) {
        return db.sql("SELECT * FROM users WHERE firebase_uid = :uid")
            .bind("uid", firebaseUid)
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

    @Override
    public Mono<User> findByEmailPreferringReal(String email) {
        return db.sql("SELECT * FROM users WHERE email = :email ORDER BY firebase_uid LIKE 'dev:%' LIMIT 1")
            .bind("email", email)
            .map(UserRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<User> create(String firebaseUid, String email, String displayName) {
        return db.sql("INSERT INTO users (firebase_uid, email, display_name) VALUES (:uid, :email, :name) RETURNING *")
            .bind("uid", firebaseUid)
            .bind("email", email)
            .bind("name", displayName == null ? io.r2dbc.spi.Parameters.in(io.r2dbc.spi.R2dbcType.VARCHAR) : displayName)
            .map(UserRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<User> adoptFirebaseUid(UUID userId, String firebaseUid) {
        return db.sql("UPDATE users SET firebase_uid = :uid WHERE id = :id RETURNING *")
            .bind("uid", firebaseUid)
            .bind("id", userId)
            .map(UserRepositoryAdapter::map)
            .one();
    }
}
