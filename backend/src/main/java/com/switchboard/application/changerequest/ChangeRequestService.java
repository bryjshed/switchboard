package com.switchboard.application.changerequest;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.flag.EnvConfigResult;
import com.switchboard.application.flag.FlagTargetingService;
import com.switchboard.application.flag.WriteTarget;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.changerequest.ChangeRequest;
import com.switchboard.domain.changerequest.ChangeRequestKind;
import com.switchboard.domain.changerequest.ChangeRequestPage;
import com.switchboard.domain.changerequest.ChangeRequestPayload;
import com.switchboard.domain.changerequest.ChangeRequestRepository;
import com.switchboard.domain.changerequest.ChangeRequestStatus;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.project.ApprovalSettings;
import com.switchboard.domain.project.Environment;
import com.switchboard.domain.project.EnvironmentRepository;
import com.switchboard.interfaces.security.AuthenticatedUser;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/**
 * The approval gate in front of the three flag-environment writes, plus the read
 * side of change requests.
 *
 * <p>When the target environment does not require approval, the call goes
 * straight through to {@link FlagTargetingService} and nothing here is
 * persisted - the ungated path costs one small environment lookup and behaves
 * exactly as it did before approvals existed. When the environment does require
 * approval the write is not performed at all; a PENDING change request is opened
 * instead and the caller is told so with 202 Accepted.
 *
 * <p>The kill switch is the exception. It is an emergency control, so it bypasses
 * approval unless {@code requireApprovalForKill} is explicitly turned on for the
 * environment. Blocking an emergency stop behind a review queue turns an incident
 * into an outage, which is why LaunchDarkly makes the same choice.
 *
 * <p>AI proposal applies come through here too, via
 * {@link #decideProposalWrite} plus {@link #openForProposal}, so there is exactly
 * one place that knows what an environment's approval policy means. A proposal
 * applied by a person is gated identically to that person's hand edit. A proposal
 * applied by the rollout monitor is gated too, unless the environment keeps
 * {@code allowAutomationBypass} on - the automation counterpart of the kill
 * switch exemption, and for the same reason.
 */
@Service
public class ChangeRequestService {

    private static final int MAX_LIMIT = 100;

    private final ChangeRequestRepository requests;
    private final FlagTargetingService targeting;
    private final EnvironmentRepository environments;
    private final FlagRepository flags;
    private final OrgAccessService access;
    private final AuditWriter audit;
    private final TransactionalOperator tx;
    private final ObjectMapper json;

    @SuppressWarnings("checkstyle:ParameterNumber")
    public ChangeRequestService(
        ChangeRequestRepository requests,
        FlagTargetingService targeting,
        EnvironmentRepository environments,
        FlagRepository flags,
        OrgAccessService access,
        AuditWriter audit,
        TransactionalOperator tx,
        ObjectMapper json) {
        this.requests = requests;
        this.targeting = targeting;
        this.environments = environments;
        this.flags = flags;
        this.access = access;
        this.audit = audit;
        this.tx = tx;
        this.json = json;
    }

    // ---------------------------------------------------------------- gated writes

    /** PUT flags/{key}/environments/{envKey}: writes, or opens a request for review. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<WriteOutcome> submitTargetingUpdate(
        UUID projectId, String flagKey, String envKey, AuthenticatedUser user,
        boolean enabled, TargetingConfig config, Integer expectedVersion, String comment) {

        return gate(projectId, envKey, ApprovalSettings::gatesWrites,
            () -> targeting.updateConfig(projectId, flagKey, envKey, user.userId(), user.email(),
                enabled, config, expectedVersion, comment),
            () -> targeting.resolveTarget(projectId, flagKey, envKey, user.userId(), Permission.FLAG_WRITE)
                .flatMap(target -> requireFresh(target, expectedVersion)
                    .then(targeting.validateProposedConfig(projectId, target.flag(), config))
                    .then(open(target, user, ChangeRequestKind.TARGETING_UPDATE,
                        ChangeRequestPayload.ofTargetingUpdate(enabled, config), comment))));
    }

    /** The emergency stop. Gated only when the environment explicitly opts in. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<WriteOutcome> submitKillSwitch(
        UUID projectId, String flagKey, String envKey, AuthenticatedUser user,
        boolean active, String reason) {

        return gate(projectId, envKey, ApprovalSettings::gatesKillSwitch,
            () -> targeting.setKillSwitch(projectId, flagKey, envKey, user.userId(), user.email(),
                active, reason),
            () -> targeting.resolveTarget(projectId, flagKey, envKey, user.userId(), Permission.FLAG_KILL)
                .flatMap(target -> open(target, user, ChangeRequestKind.KILL_SWITCH,
                    ChangeRequestPayload.ofKillSwitch(active), reason)));
    }

    /** Rollback follows the same policy as a targeting write. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<WriteOutcome> submitRollback(
        UUID projectId, String flagKey, String envKey, AuthenticatedUser user,
        int toVersion, String reason) {

        return gate(projectId, envKey, ApprovalSettings::gatesWrites,
            () -> targeting.rollback(projectId, flagKey, envKey, user.userId(), user.email(),
                toVersion, reason),
            () -> targeting.resolveTarget(projectId, flagKey, envKey, user.userId(), Permission.FLAG_ROLLBACK)
                .flatMap(target -> targeting
                    .getVersion(projectId, flagKey, envKey, user.userId(), toVersion)
                    .then(open(target, user, ChangeRequestKind.ROLLBACK,
                        ChangeRequestPayload.ofRollback(toVersion), reason))));
    }

    /**
     * One environment lookup decides which path a write takes. It is the only cost
     * this feature adds to an environment that does not require approval.
     */
    private Mono<WriteOutcome> gate(
        UUID projectId, String envKey,
        Predicate<ApprovalSettings> gated,
        Supplier<Mono<EnvConfigResult>> directWrite,
        Supplier<Mono<ChangeRequest>> openRequest) {

        return environments.findByProjectAndKey(projectId, envKey)
            .switchIfEmpty(Mono.error(new NotFoundException("Environment not found")))
            .flatMap(env -> gated.test(env.approvals())
                ? openRequest.get().map(request -> (WriteOutcome) new WriteOutcome.Pending(request))
                : directWrite.get().map(result -> (WriteOutcome) new WriteOutcome.Applied(result)));
    }

    /**
     * A stale author is told immediately rather than after a review cycle: the
     * same 409 a direct write would have got, raised before the request is opened.
     */
    private Mono<Void> requireFresh(WriteTarget target, Integer expectedVersion) {
        if (expectedVersion != null && target.head().version() != expectedVersion) {
            return Mono.error(new ConflictException(
                "Version conflict: expected v" + expectedVersion
                    + " but head is v" + target.head().version()));
        }
        return Mono.empty();
    }

    private Mono<ChangeRequest> open(
        WriteTarget target, AuthenticatedUser user, ChangeRequestKind kind,
        ChangeRequestPayload payload, String comment) {
        return open(target, user.userId(), user.email(), kind, payload, comment, null);
    }

    @SuppressWarnings("checkstyle:ParameterNumber")
    private Mono<ChangeRequest> open(
        WriteTarget target, UUID authorId, String authorLabel, ChangeRequestKind kind,
        ChangeRequestPayload payload, String comment, UUID proposalId) {

        Environment env = target.env();
        ApprovalSettings settings = env.approvals();
        ChangeRequest draft = new ChangeRequest(
            null, target.orgId(), target.projectId(), env.id(), env.key(),
            target.flag().id(), target.flag().key(), kind, payload,
            target.head().version(), settings.minApprovals(), settings.allowSelfApproval(),
            ChangeRequestStatus.PENDING, authorId, authorLabel, comment,
            null, null, null, proposalId, List.of());

        Map<String, Object> fields = new LinkedHashMap<>();
        return requests.insert(draft)
            .flatMap(saved -> {
                fields.put("changeRequestId", saved.id().toString());
                fields.put("kind", kind.name());
                fields.put("minApprovals", saved.minApprovals());
                if (proposalId != null) {
                    fields.put("aiProposalId", proposalId.toString());
                }
                return audit.insert(
                        saved.orgId(), saved.projectId(), saved.environmentId(), saved.flagKey(),
                        "CHANGE_REQUEST_OPEN", authorLabel, comment, saved.baseVersion(), null,
                        diff(fields))
                    .thenReturn(saved);
            })
            .as(tx::transactional);
    }

    // ---------------------------------------------------------------- AI proposals

    /**
     * What the environment's policy says about one write an AI proposal wants to
     * make. One environment lookup, no side effects, so the proposal service can
     * decide the whole apply before it writes anything.
     *
     * <p>A human applying a proposal is measured against exactly the predicate
     * their own hand edit would face. Automation is measured against the same
     * predicate and then allowed through when the environment keeps
     * {@code allowAutomationBypass} on, which is the default.
     */
    public Mono<ProposalGate> decideProposalWrite(
        UUID projectId, String envKey, ChangeRequestKind kind, boolean automation) {

        return environments.findByProjectAndKey(projectId, envKey)
            .switchIfEmpty(Mono.error(new NotFoundException("Environment not found")))
            .map(env -> {
                ApprovalSettings settings = env.approvals();
                boolean gated = kind == ChangeRequestKind.KILL_SWITCH
                    ? settings.gatesKillSwitch()
                    : settings.gatesWrites();
                ApprovalDecision decision;
                if (!gated) {
                    decision = ApprovalDecision.WRITE;
                } else if (automation && settings.allowAutomationBypass()) {
                    decision = ApprovalDecision.BYPASS;
                } else {
                    decision = ApprovalDecision.REVIEW;
                }
                return new ProposalGate(env.id(), env.key(), decision);
            });
    }

    /**
     * Parks one of a proposal's writes as a PENDING change request, stamped with
     * the proposal that caused it. The payload is the RESOLVED targeting config,
     * not the proposal's value-keyed draft, so what a reviewer approves is
     * literally the config that will be written.
     *
     * <p>No {@code expectedVersion} freshness check here, unlike a human write:
     * a proposal carries no version the author edited against. The baseVersion is
     * the head at the moment of parking, and the applier's staleness check still
     * refuses to clobber anything newer.
     */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<ChangeRequest> openForProposal(
        UUID projectId, String flagKey, String envKey, UUID actorUserId, String actorLabel,
        ChangeRequestKind kind, ChangeRequestPayload payload, String comment, UUID proposalId) {

        return targeting.resolveTarget(projectId, flagKey, envKey, actorUserId, permissionFor(kind))
            .flatMap(target -> validate(projectId, target, kind, payload)
                .then(open(target, actorUserId, actorLabel, kind, payload, comment, proposalId)));
    }

    /**
     * The extra audit entry a bypassed write leaves behind. It is written next to
     * the ordinary AI_APPLY entry rather than instead of it, so the version
     * history reads normally and the bypass is still greppable on its own.
     */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<Void> auditAutomationBypass(
        UUID orgId, UUID projectId, UUID environmentId, String envKey, String flagKey,
        String actorLabel, ChangeRequestKind kind, UUID proposalId) {

        return audit.insert(orgId, projectId, environmentId, flagKey, "APPROVAL_BYPASS", actorLabel,
            "Automated " + kind.name() + " applied without review in \"" + envKey
                + "\" (allowAutomationBypass is on)",
            null, null,
            diff(Map.of(
                "aiProposalId", proposalId == null ? "" : proposalId.toString(),
                "kind", kind.name(),
                "reason", "allowAutomationBypass")));
    }

    private Mono<Void> validate(
        UUID projectId, WriteTarget target, ChangeRequestKind kind, ChangeRequestPayload payload) {
        return kind == ChangeRequestKind.TARGETING_UPDATE
            ? targeting.validateProposedConfig(projectId, target.flag(), payload.config())
            : Mono.empty();
    }

    private static Permission permissionFor(ChangeRequestKind kind) {
        return switch (kind) {
            case TARGETING_UPDATE -> Permission.FLAG_WRITE;
            case KILL_SWITCH -> Permission.FLAG_KILL;
            case ROLLBACK -> Permission.FLAG_ROLLBACK;
        };
    }

    // ---------------------------------------------------------------- reads

    public Mono<ChangeRequestPage> list(
        UUID projectId, UUID userId, String envKey, String flagKey, ChangeRequestStatus status,
        String cursor, int limit) {

        int capped = Math.max(1, Math.min(limit, MAX_LIMIT));
        return resolveEnvId(projectId, envKey)
            .flatMap(env -> requireReadAccess(projectId, userId, env.id())
                .then(resolveFlagId(projectId, flagKey))
                .flatMap(flag -> requests.list(
                    projectId, env.id(), flag.id(), status, cursor, capped)));
    }

    /**
     * A listing narrowed to one environment is gated at that environment, so a
     * reviewer whose only standing is an environment-scoped APPROVER role can see
     * their own queue. Permissions never roll up from an environment to its
     * project, so the unfiltered listing still needs project-scope read.
     */
    private Mono<Void> requireReadAccess(UUID projectId, UUID userId, UUID environmentId) {
        return environmentId != null
            ? access.requireEnvironmentPermission(environmentId, userId, Permission.FLAG_READ).then()
            : access.requireProjectPermission(projectId, userId, Permission.FLAG_READ).then();
    }

    public Mono<ChangeRequest> get(UUID changeRequestId, UUID userId) {
        return requests.findById(changeRequestId)
            .switchIfEmpty(Mono.error(new NotFoundException("Change request not found")))
            .flatMap(request -> access
                .requireEnvironmentPermission(request.environmentId(), userId, Permission.FLAG_READ)
                .thenReturn(request));
    }

    /** Wraps a nullable filter id so "no filter" and "filtered" both flow through flatMap. */
    private record OptionalId(UUID id) {
    }

    private Mono<OptionalId> resolveEnvId(UUID projectId, String envKey) {
        if (envKey == null || envKey.isBlank()) {
            return Mono.just(new OptionalId(null));
        }
        return environments.findByProjectAndKey(projectId, envKey)
            .map(env -> new OptionalId(env.id()))
            .switchIfEmpty(Mono.error(new NotFoundException("Environment not found")));
    }

    /** Filtering happens on the flag id, so an archived-and-recreated key cannot bleed. */
    private Mono<OptionalId> resolveFlagId(UUID projectId, String flagKey) {
        if (flagKey == null || flagKey.isBlank()) {
            return Mono.just(new OptionalId(null));
        }
        return flags.findByProjectAndKey(projectId, flagKey)
            .map(flag -> new OptionalId(flag.id()))
            .switchIfEmpty(Mono.error(new NotFoundException("Flag not found")));
    }

    private String diff(Map<String, Object> fields) {
        try {
            return json.writeValueAsString(new LinkedHashMap<>(fields));
        } catch (JsonProcessingException e) {
            return null;
        }
    }
}
