package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.org.OrgInvitation;
import com.switchboard.domain.org.OrgInvitationRepository;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
public class OrgInvitationRepositoryAdapter implements OrgInvitationRepository {

    /** Matches the partial indexes in V14 exactly, so both lookups can use them. */
    private static final String PENDING = "accepted_at IS NULL AND revoked_at IS NULL";

    private final DatabaseClient db;

    public OrgInvitationRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    private static OrgInvitation map(Readable row) {
        return new OrgInvitation(
            row.get("id", UUID.class),
            row.get("org_id", UUID.class),
            row.get("email", String.class),
            row.get("role", String.class),
            row.get("invited_by", String.class),
            row.get("created_at", Instant.class),
            row.get("accepted_at", Instant.class),
            row.get("accepted_user_id", UUID.class),
            row.get("revoked_at", Instant.class));
    }

    @Override
    public Mono<OrgInvitation> createPending(UUID orgId, String email, String role, String invitedBy) {
        return db.sql("""
                INSERT INTO org_invitations (org_id, email, role, invited_by)
                VALUES (:orgId, :email, :role, :invitedBy)
                RETURNING *
                """)
            .bind("orgId", orgId)
            .bind("email", email)
            .bind("role", role)
            .bind("invitedBy", invitedBy)
            .map(OrgInvitationRepositoryAdapter::map)
            .one();
    }

    @Override
    public Mono<OrgInvitation> createAccepted(
        UUID orgId, String email, String role, String invitedBy, UUID userId) {
        return db.sql("""
                INSERT INTO org_invitations (org_id, email, role, invited_by, accepted_at, accepted_user_id)
                VALUES (:orgId, :email, :role, :invitedBy, now(), :userId)
                RETURNING *
                """)
            .bind("orgId", orgId)
            .bind("email", email)
            .bind("role", role)
            .bind("invitedBy", invitedBy)
            .bind("userId", userId)
            .map(OrgInvitationRepositoryAdapter::map)
            .one();
    }

    @Override
    public Flux<OrgInvitation> findPendingInOrg(UUID orgId) {
        return db.sql("SELECT * FROM org_invitations WHERE org_id = :orgId AND " + PENDING
                + " ORDER BY created_at, id")
            .bind("orgId", orgId)
            .map(OrgInvitationRepositoryAdapter::map)
            .all();
    }

    @Override
    public Flux<OrgInvitation> findPendingByEmail(String email) {
        return db.sql("SELECT * FROM org_invitations WHERE email = :email AND " + PENDING
                + " ORDER BY created_at, id")
            .bind("email", email)
            .map(OrgInvitationRepositoryAdapter::map)
            .all();
    }

    @Override
    public Mono<OrgInvitation> markAccepted(UUID invitationId, UUID userId) {
        return db.sql("UPDATE org_invitations SET accepted_at = now(), accepted_user_id = :userId"
                + " WHERE id = :id AND " + PENDING + " RETURNING *")
            .bind("id", invitationId)
            .bind("userId", userId)
            .map(OrgInvitationRepositoryAdapter::map)
            .one();
    }

    @Override
    public Flux<OrgInvitation> markPendingAccepted(UUID orgId, String email, UUID userId) {
        return db.sql("UPDATE org_invitations SET accepted_at = now(), accepted_user_id = :userId"
                + " WHERE org_id = :orgId AND email = :email AND " + PENDING + " RETURNING *")
            .bind("orgId", orgId)
            .bind("email", email)
            .bind("userId", userId)
            .map(OrgInvitationRepositoryAdapter::map)
            .all();
    }

    @Override
    public Mono<OrgInvitation> revoke(UUID orgId, UUID invitationId) {
        return db.sql("UPDATE org_invitations SET revoked_at = now()"
                + " WHERE id = :id AND org_id = :orgId AND " + PENDING + " RETURNING *")
            .bind("id", invitationId)
            .bind("orgId", orgId)
            .map(OrgInvitationRepositoryAdapter::map)
            .one();
    }
}
