package com.switchboard.application.segment;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.flag.ClauseOp;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.project.EnvironmentRepository;
import com.switchboard.domain.segment.Segment;
import com.switchboard.domain.segment.SegmentRepository;
import com.switchboard.infrastructure.notify.FlagChangePublisher;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.util.function.Tuples;

/** Segment CRUD. Delete is blocked while any head config still references the segment. */
@Service
public class SegmentService {

    private final SegmentRepository segments;
    private final FlagRepository flags;
    private final EnvironmentRepository environments;
    private final OrgAccessService access;
    private final AuditWriter audit;
    private final FlagChangePublisher publisher;
    private final TransactionalOperator tx;

    @SuppressWarnings("checkstyle:ParameterNumber")
    public SegmentService(
        SegmentRepository segments,
        FlagRepository flags,
        EnvironmentRepository environments,
        OrgAccessService access,
        AuditWriter audit,
        FlagChangePublisher publisher,
        TransactionalOperator tx) {
        this.segments = segments;
        this.flags = flags;
        this.environments = environments;
        this.access = access;
        this.audit = audit;
        this.publisher = publisher;
        this.tx = tx;
    }

    public Mono<Segment> create(UUID projectId, UUID userId, String email, Segment segment) {
        return access.requireProjectPermission(projectId, userId, Permission.SEGMENT_WRITE)
            .flatMap(projectAccess -> segments.insert(segment)
                .flatMap(saved -> audit.insert(
                        projectAccess.orgId(), projectId, null, null, "SEGMENT_CREATE", email,
                        null, null, null, "{\"segmentKey\":\"" + saved.key() + "\"}")
                    .thenReturn(saved))
                .as(tx::transactional))
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("A segment with that key already exists in this project"));
    }

    public Mono<Segment> update(UUID projectId, String key, UUID userId, String email, Segment segment) {
        return access.requireProjectPermission(projectId, userId, Permission.SEGMENT_WRITE)
            .flatMap(projectAccess -> segments.findByKey(projectId, key)
                .switchIfEmpty(Mono.error(new NotFoundException("Segment not found")))
                .flatMap(existing -> segments.update(segment)
                    .flatMap(saved -> audit.insert(
                            projectAccess.orgId(), projectId, null, null, "SEGMENT_UPDATE", email,
                            null, null, null, "{\"segmentKey\":\"" + key + "\"}")
                        .thenReturn(saved))
                    .as(tx::transactional)))
            // Segment membership feeds evaluation: refresh every env snapshot of the project.
            .flatMap(saved -> bumpAndNotifyAllEnvironments(projectId).thenReturn(saved));
    }

    public Mono<Void> delete(UUID projectId, String key, UUID userId, String email) {
        return access.requireProjectPermission(projectId, userId, Permission.SEGMENT_WRITE)
            .flatMap(projectAccess -> segments.findByKey(projectId, key)
                .switchIfEmpty(Mono.error(new NotFoundException("Segment not found")))
                .flatMap(existing -> requireUnreferenced(projectId, key)
                    .then(segments.delete(projectId, key))
                    .then(audit.insert(
                        projectAccess.orgId(), projectId, null, null, "SEGMENT_DELETE", email,
                        null, null, null, "{\"segmentKey\":\"" + key + "\"}"))
                    .as(tx::transactional)))
            .then();
    }

    public Mono<Segment> get(UUID projectId, String key, UUID userId) {
        return access.requireProjectMember(projectId, userId)
            .then(Mono.defer(() -> segments.findByKey(projectId, key)))
            .switchIfEmpty(Mono.error(new NotFoundException("Segment not found")));
    }

    public Flux<Segment> list(UUID projectId, UUID userId) {
        return access.requireProjectMember(projectId, userId)
            .thenMany(Flux.defer(() -> segments.findByProject(projectId)));
    }

    /** Conflict when any current head config's SEGMENT_MATCH clause names this segment. */
    private Mono<Void> requireUnreferenced(UUID projectId, String key) {
        return flags.findHeadConfigsByProject(projectId)
            .filter(config -> references(config, key))
            .hasElements()
            .flatMap(referenced -> referenced
                ? Mono.error(new ConflictException(
                    "Segment is referenced by flag targeting rules and cannot be deleted"))
                : Mono.empty());
    }

    private static boolean references(TargetingConfig config, String segmentKey) {
        return config.rules().stream()
            .flatMap(rule -> rule.clauses().stream())
            .anyMatch(clause -> clause.op() == ClauseOp.SEGMENT_MATCH && clause.values().contains(segmentKey));
    }

    private Mono<Void> bumpAndNotifyAllEnvironments(UUID projectId) {
        return environments.findByProject(projectId)
            .concatMap(env -> flags.bumpStateVersion(env.id())
                .map(stateVersion -> Tuples.of(env.id(), stateVersion)))
            .doOnNext(envAndVersion -> publisher.publish(envAndVersion.getT1(), "", envAndVersion.getT2()))
            .then();
    }
}
