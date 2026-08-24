package com.switchboard.application.user;

import com.switchboard.domain.org.MembershipView;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserRepository;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class UserService {

    private static final String DEV_PREFIX = "dev:";

    private final UserRepository users;
    private final DatabaseClient db;

    public UserService(UserRepository users, DatabaseClient db) {
        this.users = users;
        this.db = db;
    }

    /**
     * Resolves the user for a verified Firebase token, auto-provisioning on first login.
     * A real login adopts a dev-provisioned row for the same email by re-keying its
     * firebase_uid, so curl testing and app logins share one identity.
     */
    public Mono<User> resolveFirebaseUser(String firebaseUid, String email, String displayName) {
        return users.findByFirebaseUid(firebaseUid)
            .switchIfEmpty(Mono.defer(() -> users.findByEmailPreferringReal(email)
                .flatMap(existing -> existing.firebaseUid().startsWith(DEV_PREFIX)
                    ? users.adoptFirebaseUid(existing.id(), firebaseUid)
                    : Mono.just(existing))
                .switchIfEmpty(create(firebaseUid, email, displayName))));
    }

    /** Resolves a dev-token user by email, auto-provisioning with a dev: firebase uid. */
    public Mono<User> resolveDevUser(String email) {
        return users.findByEmailPreferringReal(email)
            .switchIfEmpty(create(DEV_PREFIX + email, email, null));
    }

    private Mono<User> create(String firebaseUid, String email, String displayName) {
        return users.create(firebaseUid, email, displayName)
            .onErrorResume(DataIntegrityViolationException.class,
                e -> users.findByFirebaseUid(firebaseUid));
    }

    public Flux<MembershipView> membershipsOf(UUID userId) {
        return db.sql("""
                SELECT o.id AS org_id, o.name AS org_name, o.slug AS org_slug, m.role
                FROM org_memberships m JOIN orgs o ON o.id = m.org_id
                WHERE m.user_id = :userId
                ORDER BY o.name
                """)
            .bind("userId", userId)
            .map(row -> new MembershipView(
                row.get("org_id", UUID.class),
                row.get("org_name", String.class),
                row.get("org_slug", String.class),
                row.get("role", String.class)))
            .all();
    }
}
