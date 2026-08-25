package com.switchboard.application.ai;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.changerequest.ApprovalDecision;
import com.switchboard.application.changerequest.ChangeRequestService;
import com.switchboard.application.flag.FlagService;
import com.switchboard.application.flag.FlagTargetingService;
import com.switchboard.application.flag.VariationInput;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.application.settings.OrgSettingsService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.AiProposalRepository;
import com.switchboard.domain.ai.DraftResult;
import com.switchboard.domain.ai.EnvChange;
import com.switchboard.domain.ai.FlagAssistantPort;
import com.switchboard.domain.ai.FlagChangeDiff;
import com.switchboard.domain.ai.FlagSnapshotItem;
import com.switchboard.domain.ai.NlRequest;
import com.switchboard.domain.ai.ProjectSnapshot;
import com.switchboard.domain.ai.ProposalKind;
import com.switchboard.domain.ai.ProposalPage;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.changerequest.ChangeRequest;
import com.switchboard.domain.changerequest.ChangeRequestKind;
import com.switchboard.domain.changerequest.ChangeRequestPayload;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.flag.Clause;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagDetail;
import com.switchboard.domain.flag.FlagKind;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.flag.NamedEnvConfig;
import com.switchboard.domain.flag.Rule;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.org.ProjectAccess;
import com.switchboard.domain.project.Environment;
import com.switchboard.domain.project.EnvironmentRepository;
import com.switchboard.domain.project.ProjectRepository;
import com.switchboard.domain.segment.Segment;
import com.switchboard.domain.segment.SegmentRepository;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Drafts, applies, and rejects AI proposals.
 *
 * <p>Applying is guarded twice. First a compare-and-set moves the row out of
 * DRAFT, so only one caller can ever proceed. Then every resulting version
 * snapshot is stamped with the proposal id, and the partial unique index on
 * {@code created_from_proposal_id} turns a second apply into a unique violation
 * that rolls the whole attempt back. The CAS is the fast path; the index is the
 * backstop that survives two instances racing.
 *
 * <p>Applying is also GATED. An apply is a flag write, so it answers to the same
 * per-environment approval policy a hand edit does, decided in
 * {@link ChangeRequestService} rather than here. In a gated environment the apply
 * writes nothing and opens PENDING change requests instead; the proposal stays
 * DRAFT until they land. The one exception is automation - the rollout monitor's
 * healing rollbacks - which an environment may let through via
 * {@code allowAutomationBypass}, on by default; those writes are still audited,
 * and additionally recorded as APPROVAL_BYPASS.
 */
@Service
public class ProposalService {

    private static final int MAX_LIMIT = 100;

    private final AiProposalRepository proposals;
    private final FlagAssistantPort assistant;
    private final OrgAccessService access;
    private final OrgSettingsService orgSettings;
    private final ProjectRepository projects;
    private final EnvironmentRepository environments;
    private final SegmentRepository segments;
    private final FlagRepository flags;
    private final FlagService flagService;
    private final FlagTargetingService targeting;
    private final ChangeRequestService changeRequests;
    private final AuditWriter audit;
    private final TransactionalOperator tx;

    @SuppressWarnings("checkstyle:ParameterNumber")
    public ProposalService(
        AiProposalRepository proposals,
        FlagAssistantPort assistant,
        OrgAccessService access,
        OrgSettingsService orgSettings,
        ProjectRepository projects,
        EnvironmentRepository environments,
        SegmentRepository segments,
        FlagRepository flags,
        FlagService flagService,
        FlagTargetingService targeting,
        ChangeRequestService changeRequests,
        AuditWriter audit,
        TransactionalOperator tx) {
        this.proposals = proposals;
        this.assistant = assistant;
        this.access = access;
        this.orgSettings = orgSettings;
        this.projects = projects;
        this.environments = environments;
        this.segments = segments;
        this.flags = flags;
        this.flagService = flagService;
        this.targeting = targeting;
        this.changeRequests = changeRequests;
        this.audit = audit;
        this.tx = tx;
    }

    // ---------------------------------------------------------------- draft

    public Mono<AiProposal> draft(
        UUID projectId, ProposalActor actor, String prompt, String envKey, String flagKey) {

        return access.requireProjectPermission(projectId, actor.userId(), Permission.FLAG_WRITE)
            .flatMap(projectAccess -> orgSettings.get(projectAccess.orgId())
                .flatMap(settings -> settings.aiEnabled()
                    ? Mono.just(projectAccess)
                    : Mono.error(new ForbiddenException("AI features are disabled for this org"))))
            .flatMap(projectAccess -> buildSnapshot(projectId)
                .flatMap(snapshot -> assistant.draftProposal(
                        new NlRequest(prompt, envKey, flagKey), snapshot)
                    .flatMap(result -> persistDraft(projectAccess, prompt, result, actor.label()))));
    }

    private Mono<AiProposal> persistDraft(
        ProjectAccess projectAccess, String prompt, DraftResult result, String actorLabel) {
        FlagChangeDiff diff = result.diff();
        return validateCoherence(projectAccess.projectId(), diff)
            .then(Mono.defer(() -> resolveEnvironmentId(projectAccess.projectId(), diff)))
            .flatMap(envId -> proposals.insert(new AiProposal(
                null, projectAccess.orgId(), projectAccess.projectId(),
                envId.orElse(null), diff.kind(), prompt, diff, result.rationale(),
                ProposalStatus.DRAFT, actorLabel, null, null, null)));
    }

    /** Environment scope is only meaningful when the diff touches exactly one env. */
    private Mono<java.util.Optional<UUID>> resolveEnvironmentId(UUID projectId, FlagChangeDiff diff) {
        if (diff.envChanges().size() != 1) {
            return Mono.just(java.util.Optional.empty());
        }
        String envKey = diff.envChanges().get(0).envKey();
        return environments.findByProject(projectId)
            .filter(env -> env.key().equals(envKey))
            .next()
            .map(env -> java.util.Optional.of(env.id()))
            .defaultIfEmpty(java.util.Optional.empty());
    }

    /**
     * Everything the model could plausibly get wrong about THIS project: an
     * invented flag key, a create that collides, an update to a flag that is not
     * there, an unknown environment, a variation value that does not exist.
     */
    private Mono<Void> validateCoherence(UUID projectId, FlagChangeDiff diff) {
        if (diff.flagKey() == null || diff.flagKey().isBlank()) {
            return Mono.error(new ValidationException("The proposal names no flag"));
        }
        return environments.findByProject(projectId).collectList().flatMap(envs -> {
            Set<String> envKeys = new LinkedHashSet<>(envs.stream().map(Environment::key).toList());
            for (EnvChange change : diff.envChanges()) {
                if (!envKeys.contains(change.envKey())) {
                    return Mono.error(new ValidationException(
                        "Unknown environment \"" + change.envKey() + "\"; known keys are " + envKeys));
                }
            }
            return flags.findByProjectAndKey(projectId, diff.flagKey())
                .map(java.util.Optional::of)
                .defaultIfEmpty(java.util.Optional.empty())
                .flatMap(existing -> validateAgainstFlag(diff, existing.orElse(null)));
        });
    }

    private Mono<Void> validateAgainstFlag(FlagChangeDiff diff, Flag existing) {
        if (diff.kind() == ProposalKind.FLAG_CREATE) {
            if (existing != null) {
                return Mono.error(new ConflictException(
                    "Flag \"" + diff.flagKey() + "\" already exists; propose a FLAG_UPDATE instead"));
            }
            if (diff.flagKind() == FlagKind.STRING && diff.variations().size() < 2) {
                return Mono.error(new ValidationException("STRING flags require at least 2 variations"));
            }
            // Values resolve against the variations the proposal is about to create.
            Flag pending = pendingFlag(diff);
            return validateTargetingValues(diff, pending);
        }
        if (existing == null) {
            return Mono.error(new NotFoundException("Flag \"" + diff.flagKey() + "\" not found"));
        }
        return validateTargetingValues(diff, existing);
    }

    private Mono<Void> validateTargetingValues(FlagChangeDiff diff, Flag flag) {
        try {
            diff.envChanges().forEach(change ->
                TargetingDraftResolver.validateResolvable(flag, change.targeting()));
        } catch (ValidationException e) {
            return Mono.error(e);
        }
        return Mono.empty();
    }

    /** A stand-in flag carrying the proposed variations, for value resolution only. */
    private static Flag pendingFlag(FlagChangeDiff diff) {
        List<Variation> variations = diff.flagKind() == FlagKind.BOOLEAN
            ? List.of(new Variation(UUID.randomUUID(), "true", "True"),
                new Variation(UUID.randomUUID(), "false", "False"))
            : diff.variations().stream()
                .map(v -> new Variation(UUID.randomUUID(), v.value(), v.name()))
                .toList();
        return new Flag(null, null, diff.flagKey(), diff.name(), diff.description(),
            diff.flagKind(), variations, diff.tags(), false);
    }

    // ---------------------------------------------------------------- read

    public Mono<AiProposal> get(UUID proposalId, ProposalActor actor) {
        return load(proposalId)
            .flatMap(proposal -> access.requireProjectMember(proposal.projectId(), actor.userId())
                .thenReturn(proposal));
    }

    public Mono<ProposalPage> list(
        UUID projectId, ProposalActor actor, ProposalStatus status, String cursor, int limit) {
        int capped = Math.max(1, Math.min(limit, MAX_LIMIT));
        return access.requireProjectMember(projectId, actor.userId())
            .then(Mono.defer(() -> proposals.listByProject(projectId, status, cursor, capped)));
    }

    // ---------------------------------------------------------------- reject

    public Mono<AiProposal> reject(UUID proposalId, ProposalActor actor) {
        return load(proposalId)
            .flatMap(proposal -> access
                .requireProjectPermission(proposal.projectId(), actor.userId(), Permission.FLAG_WRITE)
                .then(proposals.casFromDraft(proposalId, ProposalStatus.REJECTED, actor.label()))
                .flatMap(rows -> rows == 0
                    ? Mono.error(new ConflictException("Proposal is not in DRAFT status"))
                    : load(proposalId)));
    }

    // ---------------------------------------------------------------- apply

    /** Access-checked apply for a logged-in caller. */
    public Mono<ProposalOutcome> apply(UUID proposalId, ProposalActor actor, String reason) {
        return load(proposalId)
            .flatMap(proposal -> access
                .requireProjectPermission(proposal.projectId(), actor.userId(), Permission.FLAG_WRITE)
                .then(applyChecked(proposal, actor, reason)));
    }

    /** Apply for a background job that has already resolved an owner identity. */
    public Mono<ProposalOutcome> applyAsJob(AiProposal proposal, ProposalActor actor, String reason) {
        return applyChecked(proposal, actor, reason);
    }

    /**
     * An apply takes one of two shapes, decided before anything is written.
     *
     * <p>If every environment the proposal touches lets this actor write, it is
     * the path it always was: compare-and-set out of DRAFT, then the writes, all
     * in one transaction, so a failure part-way through (most importantly the
     * unique violation on created_from_proposal_id) leaves the proposal back in
     * DRAFT.
     *
     * <p>If ANY of them requires review, nothing is written at all and every
     * write the proposal wanted is parked as a PENDING change request stamped
     * with the proposal id. The proposal stays DRAFT - it has not been applied -
     * and {@link com.switchboard.application.changerequest.ChangeRequestApplier}
     * moves it to APPLIED when the last of those requests lands. A partially
     * applied proposal is never a state we allow: an all-or-nothing park is the
     * only reading of "this change needs review" that does not leave half a
     * change live in production.
     */
    private Mono<ProposalOutcome> applyChecked(AiProposal proposal, ProposalActor actor, String reason) {
        String comment = trim(reason != null ? reason : proposal.rationale());
        return plan(proposal, actor)
            .flatMap(plan -> plan.stream().anyMatch(gate -> !gate.decision().writesNow())
                ? park(proposal, actor, plan, comment)
                : applyDirect(proposal, actor, plan, comment));
    }

    /** Today's path, byte for byte, plus an audit entry for any bypassed gate. */
    private Mono<ProposalOutcome> applyDirect(
        AiProposal proposal, ProposalActor actor, List<ProposalGate> plan, String comment) {

        return proposals.casFromDraft(proposal.id(), ProposalStatus.APPLIED, actor.label())
            .flatMap(rows -> rows == 0
                ? Mono.<Void>error(new ConflictException("Proposal is not in DRAFT status"))
                : execute(proposal, actor, comment).then(auditBypasses(proposal, actor, plan)))
            .as(tx::transactional)
            .then(Mono.defer(() -> load(proposal.id())))
            .map(ProposalOutcome.Applied::new);
    }

    private Mono<Void> auditBypasses(
        AiProposal proposal, ProposalActor actor, List<ProposalGate> plan) {
        return Flux.fromIterable(plan)
            .filter(gate -> gate.decision() == ApprovalDecision.BYPASS)
            .concatMap(gate -> changeRequests.auditAutomationBypass(
                proposal.orgId(), proposal.projectId(), gate.environmentId(), gate.envKey(),
                proposal.diff().flagKey(), actor.label(), gate.kind(), proposal.id()))
            .then();
    }

    /**
     * Opens one change request per write the proposal wanted, and writes nothing.
     *
     * <p>A FLAG_CREATE is the one thing that has to happen first: a change request
     * references a flag row, so the flag has to exist before its targeting can be
     * queued. Creating it is safe on its own - a new flag lands disabled, serving
     * its off variation, with no SDK able to see a difference - and flag creation
     * is not an approval-gated operation for a human either. What gets reviewed is
     * the targeting that turns it on.
     */
    private Mono<ProposalOutcome> park(
        AiProposal proposal, ProposalActor actor, List<ProposalGate> plan, String comment) {

        FlagChangeDiff diff = proposal.diff();
        Mono<Void> prepare = diff.kind() == ProposalKind.FLAG_CREATE
            ? createFlag(proposal, actor, diff)
            : Mono.empty();
        return prepare
            .then(Mono.defer(() -> openRequests(proposal, actor, plan, comment)))
            .onErrorMap(DuplicateKeyException.class, e -> new ConflictException(
                "Proposal already has an open change request awaiting review"))
            .as(tx::transactional)
            .flatMap(opened -> load(proposal.id())
                .map(fresh -> (ProposalOutcome) new ProposalOutcome.Pending(fresh, opened.get(0))));
    }

    private Mono<List<ChangeRequest>> openRequests(
        AiProposal proposal, ProposalActor actor, List<ProposalGate> plan, String comment) {

        FlagChangeDiff diff = proposal.diff();
        if (diff.kind() == ProposalKind.ROLLBACK) {
            return changeRequests.openForProposal(
                    proposal.projectId(), diff.flagKey(), plan.get(0).envKey(),
                    actor.userId(), actor.label(), ChangeRequestKind.ROLLBACK,
                    ChangeRequestPayload.ofRollback(diff.rollbackToVersion()), comment, proposal.id())
                .map(List::of);
        }
        return flags.findByProjectAndKey(proposal.projectId(), diff.flagKey())
            .switchIfEmpty(Mono.error(new NotFoundException("Flag \"" + diff.flagKey() + "\" not found")))
            .flatMap(flag -> flags.findDetail(proposal.projectId(), diff.flagKey())
                .switchIfEmpty(Mono.error(new NotFoundException("Flag has no environment configs")))
                .flatMapMany(detail -> Flux.fromIterable(diff.envChanges())
                    .concatMap(change -> parkOneEnv(proposal, actor, flag, detail, change, comment))
                    .concatMapIterable(opened -> opened))
                .collectList());
    }

    /**
     * One env change becomes one TARGETING_UPDATE request carrying the resolved
     * config, plus - when the change also flips the kill switch - a second
     * KILL_SWITCH request. Two requests rather than one because that is how the
     * two writes exist on the direct path; a reviewer sees both and the
     * per-proposal-per-environment-per-kind unique index keeps them distinct.
     */
    private Mono<List<ChangeRequest>> parkOneEnv(
        AiProposal proposal, ProposalActor actor, Flag flag, FlagDetail detail,
        EnvChange change, String comment) {

        NamedEnvConfig current = currentConfig(detail, change.envKey());
        TargetingConfig resolved =
            TargetingDraftResolver.resolve(flag, current.config().config(), change.targeting());
        boolean enabled = change.enabled() != null ? change.enabled() : current.config().enabled();

        Mono<ChangeRequest> update = changeRequests.openForProposal(
            proposal.projectId(), proposal.diff().flagKey(), change.envKey(),
            actor.userId(), actor.label(), ChangeRequestKind.TARGETING_UPDATE,
            ChangeRequestPayload.ofTargetingUpdate(enabled, resolved), comment, proposal.id());

        if (change.killSwitchActive() == null
            || change.killSwitchActive() == current.config().killSwitchActive()) {
            return update.map(List::of);
        }
        return update.flatMap(first -> changeRequests.openForProposal(
                proposal.projectId(), proposal.diff().flagKey(), change.envKey(),
                actor.userId(), actor.label(), ChangeRequestKind.KILL_SWITCH,
                ChangeRequestPayload.ofKillSwitch(change.killSwitchActive()), comment, proposal.id())
            .map(second -> List.of(first, second)));
    }

    /**
     * The approval decision for every write this proposal wants to make, taken
     * before anything happens. RETIREMENT plans nothing: archiving a flag writes
     * no config version, so there is no change request kind that could stand for
     * it and no environment whose policy would apply.
     */
    private Mono<List<ProposalGate>> plan(AiProposal proposal, ProposalActor actor) {
        FlagChangeDiff diff = proposal.diff();
        List<PlannedWrite> writes = switch (diff.kind()) {
            case FLAG_CREATE, FLAG_UPDATE -> diff.envChanges().stream()
                .map(change -> new PlannedWrite(change.envKey(), ChangeRequestKind.TARGETING_UPDATE))
                .toList();
            case ROLLBACK -> diff.envChanges().isEmpty()
                ? List.<PlannedWrite>of()
                : List.of(new PlannedWrite(
                    diff.envChanges().get(0).envKey(), ChangeRequestKind.ROLLBACK));
            case RETIREMENT -> List.<PlannedWrite>of();
        };
        return Flux.fromIterable(writes)
            .concatMap(write -> changeRequests
                .decideProposalWrite(
                    proposal.projectId(), write.envKey(), write.kind(), actor.automation())
                .map(gate -> new ProposalGate(gate, write.kind())))
            .collectList();
    }

    /** An intended write, before the environment has been consulted. */
    private record PlannedWrite(String envKey, ChangeRequestKind kind) {
    }

    /** A decided write: the gate's answer plus which kind of write it was about. */
    private record ProposalGate(
        com.switchboard.application.changerequest.ProposalGate gate, ChangeRequestKind kind) {

        UUID environmentId() {
            return gate.environmentId();
        }

        String envKey() {
            return gate.envKey();
        }

        ApprovalDecision decision() {
            return gate.decision();
        }
    }

    private Mono<Void> execute(AiProposal proposal, ProposalActor actor, String comment) {
        FlagChangeDiff diff = proposal.diff();
        return switch (diff.kind()) {
            case FLAG_CREATE -> createFlag(proposal, actor, diff)
                .then(applyEnvChanges(proposal, actor, diff, comment));
            case FLAG_UPDATE -> applyEnvChanges(proposal, actor, diff, comment);
            case ROLLBACK -> rollback(proposal, actor, diff, comment);
            case RETIREMENT -> retire(proposal, actor, diff, comment);
        };
    }

    private Mono<Void> createFlag(AiProposal proposal, ProposalActor actor, FlagChangeDiff diff) {
        List<VariationInput> variations = diff.variations().stream()
            .map(v -> new VariationInput(v.value(), v.name()))
            .toList();
        return flagService.create(
                proposal.projectId(), actor.userId(), actor.label(), diff.flagKey(),
                diff.name() == null ? diff.flagKey() : diff.name(), diff.description(),
                diff.flagKind() == null ? FlagKind.BOOLEAN : diff.flagKind(),
                // The assistant does not decide exposure: a flag it creates is server-only until
                // a human says otherwise.
                variations, diff.tags(), false)
            .then();
    }

    /**
     * One versioned write per environment through FlagTargetingService, each
     * stamped with the proposal id. A unique violation on that stamp means the
     * proposal was already applied, and it aborts the whole apply.
     */
    private Mono<Void> applyEnvChanges(
        AiProposal proposal, ProposalActor actor, FlagChangeDiff diff, String comment) {
        if (diff.envChanges().isEmpty()) {
            return Mono.empty();
        }
        return flags.findByProjectAndKey(proposal.projectId(), diff.flagKey())
            .switchIfEmpty(Mono.error(new NotFoundException("Flag \"" + diff.flagKey() + "\" not found")))
            .flatMap(flag -> flags.findDetail(proposal.projectId(), diff.flagKey())
                .switchIfEmpty(Mono.error(new NotFoundException("Flag has no environment configs")))
                .flatMapMany(detail -> Flux.fromIterable(diff.envChanges())
                    .concatMap(change -> applyOneEnv(proposal, actor, flag, detail, change, comment)))
                .collectList()
                .flatMap(versions -> proposals.setAppliedVersion(
                    proposal.id(), versions.isEmpty() ? null : versions.get(versions.size() - 1))))
            .onErrorMap(DuplicateKeyException.class,
                e -> new ConflictException("Proposal has already been applied"))
            .then();
    }

    private Mono<Integer> applyOneEnv(
        AiProposal proposal, ProposalActor actor, Flag flag, FlagDetail detail,
        EnvChange change, String comment) {

        NamedEnvConfig current = currentConfig(detail, change.envKey());
        TargetingConfig resolved =
            TargetingDraftResolver.resolve(flag, current.config().config(), change.targeting());
        boolean enabled = change.enabled() != null ? change.enabled() : current.config().enabled();

        Mono<Integer> update = targeting.updateConfig(
                proposal.projectId(), proposal.diff().flagKey(), change.envKey(),
                actor.userId(), actor.label(), enabled, resolved, null, comment, proposal.id())
            .map(result -> result.head().version());

        if (change.killSwitchActive() == null
            || change.killSwitchActive() == current.config().killSwitchActive()) {
            return update;
        }
        // The kill switch is a separate versioned write; it never carries the
        // proposal stamp, because only one snapshot per proposal may claim it.
        return update.flatMap(version -> targeting.setKillSwitch(
                proposal.projectId(), proposal.diff().flagKey(), change.envKey(),
                actor.userId(), actor.label(), change.killSwitchActive(), comment)
            .map(result -> result.head().version()));
    }

    /** The flag's current head in one environment; absent is a coherence failure. */
    private static NamedEnvConfig currentConfig(FlagDetail detail, String envKey) {
        return detail.envConfigs().stream()
            .filter(named -> named.envKey().equals(envKey))
            .findFirst()
            .orElseThrow(() -> new NotFoundException(
                "Flag has no config in environment \"" + envKey + "\""));
    }

    private Mono<Void> rollback(
        AiProposal proposal, ProposalActor actor, FlagChangeDiff diff, String comment) {
        if (diff.rollbackToVersion() == null || diff.envChanges().isEmpty()) {
            return Mono.error(new ValidationException(
                "A ROLLBACK proposal needs rollbackToVersion and one environment"));
        }
        String envKey = diff.envChanges().get(0).envKey();
        return targeting.rollback(
                proposal.projectId(), diff.flagKey(), envKey, actor.userId(), actor.label(),
                diff.rollbackToVersion(), comment, proposal.id())
            .onErrorMap(DuplicateKeyException.class,
                e -> new ConflictException("Proposal has already been applied"))
            .flatMap(result -> proposals.setAppliedVersion(proposal.id(), result.head().version()));
    }

    /**
     * Retirement archives the flag. No version snapshot is written, so the CAS on
     * ai_proposals is the only guard here - hence the explicit AI_APPLY audit row.
     *
     * <p>It is also the one apply no approval policy covers: there is no change
     * request kind for archiving, because archiving writes no config version. A
     * retirement in a gated environment therefore still applies directly, exactly
     * as an archive from the flags API does.
     */
    private Mono<Void> retire(
        AiProposal proposal, ProposalActor actor, FlagChangeDiff diff, String comment) {
        return flagService.archive(proposal.projectId(), diff.flagKey(), actor.userId(), actor.label())
            .then(audit.insert(proposal.orgId(), proposal.projectId(), null, diff.flagKey(),
                "AI_APPLY", actor.label(), comment, null, null, null));
    }

    private Mono<AiProposal> load(UUID proposalId) {
        return proposals.findById(proposalId)
            .switchIfEmpty(Mono.error(new NotFoundException("Proposal not found")));
    }

    private static String trim(String reason) {
        if (reason == null) {
            return null;
        }
        String trimmed = reason.trim();
        return trimmed.length() <= 500 ? trimmed : trimmed.substring(0, 497) + "...";
    }

    // ---------------------------------------------------------------- snapshot

    /** What the assistant is allowed to see: keys, kinds, values - never telemetry or secrets. */
    public Mono<ProjectSnapshot> buildSnapshot(UUID projectId) {
        return Mono.zip(
                projects.findById(projectId)
                    .switchIfEmpty(Mono.error(new NotFoundException("Project not found"))),
                environments.findByProject(projectId).map(Environment::key).collectList(),
                segments.findByProject(projectId).map(Segment::key).collectList(),
                flags.list(projectId, null, null, null, 200).collectList(),
                flags.findHeadConfigsByProject(projectId).collectList())
            .flatMap(t -> Flux.fromIterable(t.getT4())
                .concatMap(item -> flags.findByProjectAndKey(projectId, item.key()))
                .map(flag -> new FlagSnapshotItem(
                    flag.key(), flag.kind(),
                    flag.variations().stream().map(Variation::value).toList(),
                    flag.tags()))
                .collectList()
                .map(flagItems -> new ProjectSnapshot(
                    t.getT1().key(), flagItems, t.getT3(), t.getT2(),
                    attributeHints(t.getT5()))));
    }

    /** The context attributes existing rules already reference, so the model reuses the vocabulary. */
    private static List<String> attributeHints(List<TargetingConfig> configs) {
        Set<String> attributes = new LinkedHashSet<>(List.of("key", "email", "country", "plan"));
        for (TargetingConfig config : configs) {
            for (Rule rule : config.rules()) {
                for (Clause clause : rule.clauses()) {
                    attributes.add(clause.attribute());
                }
            }
        }
        return new ArrayList<>(attributes);
    }

    /** Kept for callers that build a diff programmatically (the rollout monitor). */
    public Mono<AiProposal> insertDraft(AiProposal proposal) {
        return proposals.insert(proposal);
    }

    /** Exposed so the monitor can skip a flag that already has an open draft. */
    public Mono<Boolean> draftExists(
        UUID projectId, UUID environmentId, String flagKey, ProposalKind kind) {
        return proposals.draftExists(projectId, environmentId, flagKey, kind);
    }
}
