package com.switchboard.infrastructure.persistence.adapter;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.changerequest.ChangeRequest;
import com.switchboard.domain.changerequest.ChangeRequestKind;
import com.switchboard.domain.changerequest.ChangeRequestPage;
import com.switchboard.domain.changerequest.ChangeRequestPayload;
import com.switchboard.domain.changerequest.ChangeRequestRepository;
import com.switchboard.domain.changerequest.ChangeRequestReview;
import com.switchboard.domain.changerequest.ChangeRequestStatus;
import com.switchboard.domain.changerequest.ReviewDecision;
import com.switchboard.domain.common.ValidationException;
import io.r2dbc.spi.Readable;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * change_requests and change_request_reviews. The proposed write is a JSONB
 * column carrying the FlagTargetingService argument shape, written through
 * CAST(:x AS jsonb) and read back with the injected Jackson 2 mapper, exactly as
 * ai_proposals does with its diff.
 */
@Repository
public class ChangeRequestRepositoryAdapter implements ChangeRequestRepository {

    /** The environment key is joined in for display; everything else is the row. */
    private static final String SELECT_ROW = """
        SELECT cr.id, cr.org_id, cr.project_id, cr.environment_id, e.key AS environment_key,
               cr.flag_id, cr.flag_key, cr.kind, cr.payload, cr.base_version, cr.min_approvals,
               cr.allow_self_approval, cr.status, cr.requested_by_user_id, cr.requested_by,
               cr.comment, cr.created_at, cr.decided_at, cr.applied_version, cr.ai_proposal_id
        FROM change_requests cr
        JOIN environments e ON e.id = cr.environment_id
        """;

    private final DatabaseClient db;
    private final ObjectMapper json;

    public ChangeRequestRepositoryAdapter(DatabaseClient db, ObjectMapper json) {
        this.db = db;
        this.json = json;
    }

    @Override
    public Mono<ChangeRequest> insert(ChangeRequest request) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                WITH inserted AS (
                    INSERT INTO change_requests
                        (org_id, project_id, environment_id, flag_id, flag_key, kind, payload,
                         base_version, min_approvals, allow_self_approval, status,
                         requested_by_user_id, requested_by, comment, ai_proposal_id)
                    VALUES (:orgId, :projectId, :envId, :flagId, :flagKey, :kind, CAST(:payload AS jsonb),
                            :baseVersion, :minApprovals, :allowSelfApproval, :status,
                            :requestedByUserId, :requestedBy, :comment, :aiProposalId)
                    RETURNING *
                )
                SELECT cr.id, cr.org_id, cr.project_id, cr.environment_id, e.key AS environment_key,
                       cr.flag_id, cr.flag_key, cr.kind, cr.payload, cr.base_version, cr.min_approvals,
                       cr.allow_self_approval, cr.status, cr.requested_by_user_id, cr.requested_by,
                       cr.comment, cr.created_at, cr.decided_at, cr.applied_version, cr.ai_proposal_id
                FROM inserted cr JOIN environments e ON e.id = cr.environment_id
                """)
            .bind("orgId", request.orgId())
            .bind("projectId", request.projectId())
            .bind("envId", request.environmentId())
            .bind("flagId", request.flagId())
            .bind("flagKey", request.flagKey())
            .bind("kind", request.kind().name())
            .bind("payload", writePayload(request.payload()))
            .bind("baseVersion", request.baseVersion())
            .bind("minApprovals", request.minApprovals())
            .bind("allowSelfApproval", request.allowSelfApproval())
            .bind("status", request.status().name())
            .bind("requestedByUserId", request.requestedByUserId())
            .bind("requestedBy", request.requestedBy());
        spec = bindNullable(spec, "comment", request.comment(), String.class);
        spec = bindNullable(spec, "aiProposalId", request.aiProposalId(), UUID.class);
        return spec.map(this::mapRequest).one();
    }

    @Override
    public Mono<ChangeRequest> findById(UUID changeRequestId) {
        return db.sql(SELECT_ROW + " WHERE cr.id = :id")
            .bind("id", changeRequestId)
            .map(this::mapRequest)
            .one()
            .flatMap(this::withReviews);
    }

    @Override
    public Mono<ChangeRequest> lockById(UUID changeRequestId) {
        return db.sql("""
                SELECT cr.id, cr.org_id, cr.project_id, cr.environment_id, e.key AS environment_key,
                       cr.flag_id, cr.flag_key, cr.kind, cr.payload, cr.base_version, cr.min_approvals,
                       cr.allow_self_approval, cr.status, cr.requested_by_user_id, cr.requested_by,
                       cr.comment, cr.created_at, cr.decided_at, cr.applied_version, cr.ai_proposal_id
                FROM change_requests cr
                JOIN environments e ON e.id = cr.environment_id
                WHERE cr.id = :id
                FOR UPDATE OF cr
                """)
            .bind("id", changeRequestId)
            .map(this::mapRequest)
            .one();
    }

    @Override
    public Mono<ChangeRequestPage> list(
        UUID projectId, UUID environmentId, UUID flagId, ChangeRequestStatus status,
        String cursor, int limit) {

        Cursor after = Cursor.decode(cursor);
        StringBuilder sql = new StringBuilder(SELECT_ROW).append(" WHERE cr.project_id = :projectId");
        if (environmentId != null) {
            sql.append(" AND cr.environment_id = :envId");
        }
        if (flagId != null) {
            sql.append(" AND cr.flag_id = :flagId");
        }
        if (status != null) {
            sql.append(" AND cr.status = :status");
        }
        if (after != null) {
            sql.append(" AND (cr.created_at, cr.id) < (:afterCreatedAt, :afterId)");
        }
        sql.append(" ORDER BY cr.created_at DESC, cr.id DESC LIMIT :limit");

        DatabaseClient.GenericExecuteSpec spec = db.sql(sql.toString())
            .bind("projectId", projectId)
            .bind("limit", limit);
        if (environmentId != null) {
            spec = spec.bind("envId", environmentId);
        }
        if (flagId != null) {
            spec = spec.bind("flagId", flagId);
        }
        if (status != null) {
            spec = spec.bind("status", status.name());
        }
        if (after != null) {
            spec = spec.bind("afterCreatedAt", after.createdAt()).bind("afterId", after.id());
        }
        return spec.map(this::mapRequest)
            .all()
            .concatMap(this::withReviews)
            .collectList()
            .map(items -> new ChangeRequestPage(
                items,
                items.size() == limit ? Cursor.encode(items.get(items.size() - 1)) : null));
    }

    @Override
    public Flux<ChangeRequestReview> findReviews(UUID changeRequestId) {
        return db.sql("""
                SELECT id, change_request_id, reviewer_user_id, reviewer, decision, comment,
                       created_at, updated_at
                FROM change_request_reviews
                WHERE change_request_id = :id
                ORDER BY created_at, id
                """)
            .bind("id", changeRequestId)
            .map(ChangeRequestRepositoryAdapter::mapReview)
            .all();
    }

    @Override
    public Mono<Void> upsertReview(
        UUID changeRequestId, UUID reviewerUserId, String reviewer, ReviewDecision decision, String comment) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                INSERT INTO change_request_reviews
                    (change_request_id, reviewer_user_id, reviewer, decision, comment)
                VALUES (:id, :reviewerUserId, :reviewer, :decision, :comment)
                ON CONFLICT (change_request_id, reviewer_user_id)
                DO UPDATE SET decision = EXCLUDED.decision,
                              comment = EXCLUDED.comment,
                              reviewer = EXCLUDED.reviewer,
                              updated_at = now()
                """)
            .bind("id", changeRequestId)
            .bind("reviewerUserId", reviewerUserId)
            .bind("reviewer", reviewer)
            .bind("decision", decision.name());
        spec = bindNullable(spec, "comment", comment, String.class);
        return spec.then();
    }

    @Override
    public Mono<Long> casStatus(UUID changeRequestId, ChangeRequestStatus from, ChangeRequestStatus to) {
        return db.sql("""
                UPDATE change_requests
                SET status = :to, decided_at = coalesce(decided_at, now())
                WHERE id = :id AND status = :from
                """)
            .bind("id", changeRequestId)
            .bind("from", from.name())
            .bind("to", to.name())
            .fetch()
            .rowsUpdated();
    }

    @Override
    public Mono<Void> setAppliedVersion(UUID changeRequestId, Integer version) {
        DatabaseClient.GenericExecuteSpec spec = db.sql(
                "UPDATE change_requests SET applied_version = :version WHERE id = :id")
            .bind("id", changeRequestId);
        spec = bindNullable(spec, "version", version, Integer.class);
        return spec.then();
    }

    @Override
    public Mono<Long> countNotAppliedByProposal(UUID aiProposalId, UUID excludingId) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                SELECT count(*) FROM change_requests
                WHERE ai_proposal_id = :proposalId
                  AND status <> 'APPLIED'
                  AND (:excludingId IS NULL OR id <> :excludingId)
                """)
            .bind("proposalId", aiProposalId);
        spec = bindNullable(spec, "excludingId", excludingId, UUID.class);
        return spec.map(row -> row.get(0, Long.class)).one();
    }

    // ---------------------------------------------------------------- mapping

    private Mono<ChangeRequest> withReviews(ChangeRequest request) {
        return findReviews(request.id()).collectList().map(request::withReviews);
    }

    private ChangeRequest mapRequest(Readable row) {
        return new ChangeRequest(
            row.get("id", UUID.class),
            row.get("org_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("environment_id", UUID.class),
            row.get("environment_key", String.class),
            row.get("flag_id", UUID.class),
            row.get("flag_key", String.class),
            ChangeRequestKind.valueOf(row.get("kind", String.class)),
            readPayload(row.get("payload", String.class)),
            row.get("base_version", Integer.class),
            row.get("min_approvals", Integer.class),
            Boolean.TRUE.equals(row.get("allow_self_approval", Boolean.class)),
            ChangeRequestStatus.valueOf(row.get("status", String.class)),
            row.get("requested_by_user_id", UUID.class),
            row.get("requested_by", String.class),
            row.get("comment", String.class),
            row.get("created_at", Instant.class),
            row.get("decided_at", Instant.class),
            row.get("applied_version", Integer.class),
            row.get("ai_proposal_id", UUID.class),
            List.of());
    }

    private static ChangeRequestReview mapReview(Readable row) {
        return new ChangeRequestReview(
            row.get("id", UUID.class),
            row.get("change_request_id", UUID.class),
            row.get("reviewer_user_id", UUID.class),
            row.get("reviewer", String.class),
            ReviewDecision.valueOf(row.get("decision", String.class)),
            row.get("comment", String.class),
            row.get("created_at", Instant.class),
            row.get("updated_at", Instant.class));
    }

    private String writePayload(ChangeRequestPayload payload) {
        try {
            return json.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new ValidationException("Cannot serialize the change request payload");
        }
    }

    private ChangeRequestPayload readPayload(String raw) {
        try {
            return json.readValue(raw, ChangeRequestPayload.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Corrupt change_requests.payload", e);
        }
    }

    private static DatabaseClient.GenericExecuteSpec bindNullable(
        DatabaseClient.GenericExecuteSpec spec, String name, Object value, Class<?> type) {
        return value == null ? spec.bindNull(name, type) : spec.bind(name, value);
    }

    private record Cursor(Instant createdAt, UUID id) {

        static String encode(ChangeRequest last) {
            String raw = last.createdAt() + "|" + last.id();
            return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
        }

        static Cursor decode(String cursor) {
            if (cursor == null || cursor.isBlank()) {
                return null;
            }
            try {
                String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
                List<String> parts = List.of(raw.split("\\|", 2));
                return new Cursor(Instant.parse(parts.get(0)), UUID.fromString(parts.get(1)));
            } catch (RuntimeException e) {
                throw new ValidationException("Malformed cursor");
            }
        }
    }
}
