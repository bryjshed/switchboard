package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.org.Org;
import com.switchboard.domain.org.OrgMemberView;
import com.switchboard.domain.org.OrgRepository;
import com.switchboard.domain.org.OrgWithRole;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
public class OrgRepositoryAdapter implements OrgRepository {

    private final DatabaseClient db;

    public OrgRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    private static Org mapOrg(Readable row) {
        return new Org(
            row.get("id", UUID.class),
            row.get("name", String.class),
            row.get("slug", String.class),
            row.get("created_at", Instant.class));
    }

    private static OrgMemberView mapMember(Readable row) {
        return new OrgMemberView(
            row.get("user_id", UUID.class),
            row.get("email", String.class),
            row.get("display_name", String.class),
            row.get("role", String.class),
            row.get("joined_at", Instant.class));
    }

    @Override
    public Mono<Boolean> slugExists(String slug) {
        return db.sql("SELECT EXISTS (SELECT 1 FROM orgs WHERE slug = :slug) AS present")
            .bind("slug", slug)
            .map(row -> Boolean.TRUE.equals(row.get("present", Boolean.class)))
            .one();
    }

    @Override
    public Mono<Org> create(String name, String slug) {
        return db.sql("INSERT INTO orgs (name, slug) VALUES (:name, :slug) RETURNING *")
            .bind("name", name)
            .bind("slug", slug)
            .map(OrgRepositoryAdapter::mapOrg)
            .one();
    }

    @Override
    public Mono<Org> findById(UUID orgId) {
        return db.sql("SELECT * FROM orgs WHERE id = :id")
            .bind("id", orgId)
            .map(OrgRepositoryAdapter::mapOrg)
            .one();
    }

    @Override
    public Flux<OrgWithRole> findAllForUser(UUID userId) {
        return db.sql("""
                SELECT o.id, o.name, o.slug, m.role, o.created_at
                FROM org_memberships m JOIN orgs o ON o.id = m.org_id
                WHERE m.user_id = :userId
                ORDER BY o.name
                """)
            .bind("userId", userId)
            .map(row -> new OrgWithRole(
                row.get("id", UUID.class),
                row.get("name", String.class),
                row.get("slug", String.class),
                row.get("role", String.class),
                row.get("created_at", Instant.class)))
            .all();
    }

    @Override
    public Flux<OrgMemberView> findMembers(UUID orgId) {
        return db.sql("""
                SELECT m.user_id, u.email, u.display_name, m.role, m.created_at AS joined_at
                FROM org_memberships m JOIN users u ON u.id = m.user_id
                WHERE m.org_id = :orgId
                ORDER BY m.created_at
                """)
            .bind("orgId", orgId)
            .map(OrgRepositoryAdapter::mapMember)
            .all();
    }

    @Override
    public Mono<OrgMemberView> addMember(UUID orgId, UUID userId, String role) {
        return db.sql("""
                WITH ins AS (
                    INSERT INTO org_memberships (org_id, user_id, role)
                    VALUES (:orgId, :userId, :role)
                    RETURNING user_id, role, created_at
                )
                SELECT ins.user_id, u.email, u.display_name, ins.role, ins.created_at AS joined_at
                FROM ins JOIN users u ON u.id = ins.user_id
                """)
            .bind("orgId", orgId)
            .bind("userId", userId)
            .bind("role", role)
            .map(OrgRepositoryAdapter::mapMember)
            .one();
    }

    @Override
    public Mono<String> findMemberRole(UUID orgId, UUID userId) {
        return db.sql("SELECT role FROM org_memberships WHERE org_id = :orgId AND user_id = :userId")
            .bind("orgId", orgId)
            .bind("userId", userId)
            .map(row -> row.get("role", String.class))
            .one();
    }

    @Override
    public Mono<Long> countByRole(UUID orgId, String role) {
        return db.sql("SELECT count(*) AS n FROM org_memberships WHERE org_id = :orgId AND role = :role")
            .bind("orgId", orgId)
            .bind("role", role)
            .map(row -> row.get("n", Long.class))
            .one();
    }

    @Override
    public Mono<Long> removeMember(UUID orgId, UUID userId) {
        return db.sql("DELETE FROM org_memberships WHERE org_id = :orgId AND user_id = :userId")
            .bind("orgId", orgId)
            .bind("userId", userId)
            .fetch()
            .rowsUpdated();
    }

    @Override
    public Mono<UUID> findAnyOwnerId(UUID orgId) {
        return db.sql("""
                SELECT user_id FROM org_memberships
                WHERE org_id = :orgId AND role = 'OWNER'
                ORDER BY created_at LIMIT 1
                """)
            .bind("orgId", orgId)
            .map(row -> row.get("user_id", UUID.class))
            .one();
    }
}
