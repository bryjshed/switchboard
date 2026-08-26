package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.user.ScimUser;
import com.switchboard.domain.user.ScimUserRepository;
import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * SCIM reads and writes over {@code users}, always joined through {@code org_memberships}.
 *
 * <p>The join is the tenancy boundary. A provisioning integration authenticated for one org must
 * not be able to read or modify a user who belongs to another, and doing that with a WHERE on the
 * membership table rather than a check in Java means there is no code path that can forget.
 */
@Repository
public class ScimUserRepositoryAdapter implements ScimUserRepository {

    private static final String SELECT = """
        SELECT u.id, u.email, u.display_name, u.scim_external_id, u.deactivated_at, u.created_at
        FROM users u
        JOIN org_memberships m ON m.user_id = u.id AND m.org_id = :orgId
        """;

    private final DatabaseClient db;

    public ScimUserRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Mono<ScimUser> findInOrgById(UUID orgId, UUID userId) {
        return db.sql(SELECT + " WHERE u.id = :userId")
            .bind("orgId", orgId)
            .bind("userId", userId)
            .map(ScimUserRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<ScimUser> findInOrgByEmail(UUID orgId, String email) {
        return db.sql(SELECT + " WHERE lower(u.email) = :email")
            .bind("orgId", orgId)
            .bind("email", email)
            .map(ScimUserRepositoryAdapter::map)
            .first();
    }

    @Override
    public Mono<ScimUser> findInOrgByExternalId(UUID orgId, String externalId) {
        return db.sql(SELECT + " WHERE u.scim_external_id = :externalId")
            .bind("orgId", orgId)
            .bind("externalId", externalId)
            .map(ScimUserRepositoryAdapter::map)
            .one();
    }

    /**
     * SCIM's startIndex is ONE-based, which is the most common integration bug in this protocol.
     * The conversion happens here, once, rather than at each caller.
     */
    @Override
    public Flux<ScimUser> listInOrg(UUID orgId, String emailFilter, int startIndex, int count) {
        return db.sql(SELECT + """
                 WHERE (:email IS NULL OR lower(u.email) = :email)
                 ORDER BY u.created_at, u.id
                 LIMIT :count OFFSET :offset
                """)
            .bind("orgId", orgId)
            .bind("email", emailFilter == null ? Parameters.in(String.class) : emailFilter)
            .bind("count", count)
            .bind("offset", Math.max(0, startIndex - 1))
            .map(ScimUserRepositoryAdapter::map)
            .all();
    }

    @Override
    public Mono<Long> countInOrg(UUID orgId, String emailFilter) {
        return db.sql("""
                SELECT count(*) AS total
                FROM users u
                JOIN org_memberships m ON m.user_id = u.id AND m.org_id = :orgId
                WHERE (:email IS NULL OR lower(u.email) = :email)
                """)
            .bind("orgId", orgId)
            .bind("email", emailFilter == null ? Parameters.in(String.class) : emailFilter)
            .map(row -> row.get("total", Long.class))
            .one();
    }

    @Override
    public Mono<ScimUser> setExternalId(UUID userId, String externalId) {
        return db.sql("""
                UPDATE users SET scim_external_id = :externalId WHERE id = :userId
                RETURNING
                id, email, display_name, scim_external_id, deactivated_at, created_at
                """)
            .bind("userId", userId)
            .bind("externalId", externalId)
            .map(ScimUserRepositoryAdapter::map)
            .one();
    }

    /** A null field means "leave it alone", which is what PATCH needs and PUT tolerates. */
    @Override
    public Mono<ScimUser> updateProfile(UUID userId, String email, String displayName) {
        return db.sql("""
                UPDATE users SET
                    email = COALESCE(:email, email),
                    display_name = COALESCE(:displayName, display_name)
                WHERE id = :userId
                RETURNING
                id, email, display_name, scim_external_id, deactivated_at, created_at
                """)
            .bind("userId", userId)
            .bind("email", email == null ? Parameters.in(String.class) : email)
            .bind("displayName", displayName == null ? Parameters.in(String.class) : displayName)
            .map(ScimUserRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<ScimUser> setDeactivatedAt(UUID userId, Instant deactivatedAt) {
        // Bound with an explicit type: a plain null cannot be assigned to a timestamptz column
        // without one, and re-activation is exactly the null case.
        return db.sql("""
                UPDATE users SET deactivated_at = :deactivatedAt WHERE id = :userId
                RETURNING
                id, email, display_name, scim_external_id, deactivated_at, created_at
                """)
            .bind("userId", userId)
            .bind("deactivatedAt", deactivatedAt == null ? Parameters.in(Instant.class) : deactivatedAt)
            .map(ScimUserRepositoryAdapter::map)
            .one();
    }

    private static ScimUser map(Readable row) {
        return new ScimUser(
            row.get("id", UUID.class),
            row.get("email", String.class),
            row.get("display_name", String.class),
            row.get("scim_external_id", String.class),
            row.get("deactivated_at", Instant.class),
            row.get("created_at", Instant.class));
    }
}
