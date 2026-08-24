package com.switchboard.infrastructure.persistence.adapter;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.AiProposalRepository;
import com.switchboard.domain.ai.FlagChangeDiff;
import com.switchboard.domain.ai.ProposalKind;
import com.switchboard.domain.ai.ProposalPage;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.common.ValidationException;
import io.r2dbc.spi.Readable;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Mono;

/**
 * ai_proposals. The typed diff is a JSONB column written via CAST(:x AS jsonb)
 * and read back through the injected Jackson 2 mapper.
 */
@Repository
public class AiProposalRepositoryAdapter implements AiProposalRepository {

    private static final String COLUMNS = """
        id, org_id, project_id, environment_id, kind, source_prompt, diff, rationale,
        status, created_by, applied_by, applied_version, created_at
        """;

    private final DatabaseClient db;
    private final ObjectMapper json;

    public AiProposalRepositoryAdapter(DatabaseClient db, ObjectMapper json) {
        this.db = db;
        this.json = json;
    }

    @Override
    public Mono<AiProposal> insert(AiProposal proposal) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                INSERT INTO ai_proposals
                    (org_id, project_id, environment_id, kind, source_prompt, diff, rationale, status, created_by)
                VALUES (:orgId, :projectId, :envId, :kind, :sourcePrompt, CAST(:diff AS jsonb),
                        :rationale, :status, :createdBy)
                RETURNING
                """ + COLUMNS)
            .bind("orgId", proposal.orgId())
            .bind("projectId", proposal.projectId())
            .bind("kind", proposal.kind().name())
            .bind("diff", writeDiff(proposal.diff()))
            .bind("status", proposal.status().name())
            .bind("createdBy", proposal.createdBy());
        spec = bindNullable(spec, "envId", proposal.environmentId(), UUID.class);
        spec = bindNullable(spec, "sourcePrompt", proposal.sourcePrompt(), String.class);
        spec = bindNullable(spec, "rationale", proposal.rationale(), String.class);
        return spec.map(this::map).one();
    }

    @Override
    public Mono<AiProposal> findById(UUID proposalId) {
        return db.sql("SELECT " + COLUMNS + " FROM ai_proposals WHERE id = :id")
            .bind("id", proposalId)
            .map(this::map)
            .one();
    }

    @Override
    public Mono<Long> casFromDraft(UUID proposalId, ProposalStatus toStatus, String actor) {
        // APPLIED records who applied it; REJECTED/EXPIRED leave applied_by alone.
        String sql = toStatus == ProposalStatus.APPLIED
            ? """
                UPDATE ai_proposals SET status = :toStatus, applied_by = :actor, updated_at = now()
                WHERE id = :id AND status = 'DRAFT'
                """
            : """
                UPDATE ai_proposals SET status = :toStatus, updated_at = now()
                WHERE id = :id AND status = 'DRAFT'
                """;
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql)
            .bind("id", proposalId)
            .bind("toStatus", toStatus.name());
        if (toStatus == ProposalStatus.APPLIED) {
            spec = spec.bind("actor", actor);
        }
        return spec.fetch().rowsUpdated();
    }

    @Override
    public Mono<Void> setAppliedVersion(UUID proposalId, Integer version) {
        if (version == null) {
            return Mono.empty();
        }
        return db.sql("UPDATE ai_proposals SET applied_version = :v, updated_at = now() WHERE id = :id")
            .bind("id", proposalId)
            .bind("v", version)
            .then();
    }

    @Override
    public Mono<ProposalPage> listByProject(UUID projectId, ProposalStatus status, String cursor, int limit) {
        Cursor after = decodeCursor(cursor);
        StringBuilder sql = new StringBuilder("SELECT " + COLUMNS + " FROM ai_proposals WHERE project_id = :projectId");
        if (status != null) {
            sql.append(" AND status = :status");
        }
        if (after != null) {
            sql.append(" AND (created_at, id) < (:afterAt, :afterId)");
        }
        sql.append(" ORDER BY created_at DESC, id DESC LIMIT :limit");

        DatabaseClient.GenericExecuteSpec spec = db.sql(sql.toString())
            .bind("projectId", projectId)
            .bind("limit", limit);
        if (status != null) {
            spec = spec.bind("status", status.name());
        }
        if (after != null) {
            spec = spec.bind("afterAt", after.createdAt()).bind("afterId", after.id());
        }
        return spec.map(this::map).all().collectList()
            .map(items -> new ProposalPage(
                items,
                items.size() == limit
                    ? encodeCursor(items.get(items.size() - 1).createdAt(), items.get(items.size() - 1).id())
                    : null));
    }

    @Override
    public Mono<Boolean> draftExists(UUID projectId, UUID environmentId, String flagKey, ProposalKind kind) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                SELECT 1 FROM ai_proposals
                WHERE project_id = :projectId AND status = 'DRAFT' AND kind = :kind
                  AND environment_id IS NOT DISTINCT FROM :envId
                  AND diff ->> 'flagKey' = :flagKey
                LIMIT 1
                """)
            .bind("projectId", projectId)
            .bind("kind", kind.name())
            .bind("flagKey", flagKey);
        spec = bindNullable(spec, "envId", environmentId, UUID.class);
        return spec.map(row -> true)
            .one()
            .defaultIfEmpty(false);
    }

    // ---------------------------------------------------------------- mapping

    private AiProposal map(Readable row) {
        return new AiProposal(
            row.get("id", UUID.class),
            row.get("org_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("environment_id", UUID.class),
            ProposalKind.valueOf(row.get("kind", String.class)),
            row.get("source_prompt", String.class),
            readDiff(row.get("diff", String.class)),
            row.get("rationale", String.class),
            ProposalStatus.valueOf(row.get("status", String.class)),
            row.get("created_by", String.class),
            row.get("applied_by", String.class),
            row.get("applied_version", Integer.class),
            row.get("created_at", Instant.class));
    }

    private String writeDiff(FlagChangeDiff diff) {
        try {
            return json.writeValueAsString(diff);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Cannot serialize proposal diff", e);
        }
    }

    private FlagChangeDiff readDiff(String raw) {
        try {
            return json.readValue(raw, FlagChangeDiff.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Cannot read proposal diff", e);
        }
    }

    private record Cursor(Instant createdAt, UUID id) {
    }

    private static String encodeCursor(Instant createdAt, UUID id) {
        String raw = createdAt.toString() + "|" + id;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    private static Cursor decodeCursor(String cursor) {
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

    private static DatabaseClient.GenericExecuteSpec bindNullable(
        DatabaseClient.GenericExecuteSpec spec, String name, Object value, Class<?> type) {
        return value == null ? spec.bindNull(name, type) : spec.bind(name, value);
    }
}
