package com.switchboard.application.flag;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.flag.Clause;
import com.switchboard.domain.flag.ClauseOp;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.flag.FlagEnvConfigVersion;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.flag.WeightedVariation;
import com.switchboard.domain.project.Environment;
import com.switchboard.domain.project.EnvironmentRepository;
import com.switchboard.domain.segment.Segment;
import com.switchboard.domain.segment.SegmentRepository;
import com.switchboard.infrastructure.notify.FlagChangePublisher;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/**
 * The versioned write path for one flag in one environment. Every mutation runs
 * in one transaction that locks the head row FOR UPDATE, writes the new head
 * (version+1), appends an immutable snapshot, writes an audit entry, and bumps
 * environments.state_version; after commit it fires pg_notify (fire-and-forget).
 */
@Service
public class FlagTargetingService {

    private final FlagRepository flags;
    private final EnvironmentRepository environments;
    private final SegmentRepository segments;
    private final OrgAccessService access;
    private final AuditWriter audit;
    private final FlagChangePublisher publisher;
    private final TransactionalOperator tx;
    private final ObjectMapper json;

    @SuppressWarnings("checkstyle:ParameterNumber")
    public FlagTargetingService(
        FlagRepository flags,
        EnvironmentRepository environments,
        SegmentRepository segments,
        OrgAccessService access,
        AuditWriter audit,
        FlagChangePublisher publisher,
        TransactionalOperator tx,
        ObjectMapper json) {
        this.flags = flags;
        this.environments = environments;
        this.segments = segments;
        this.access = access;
        this.audit = audit;
        this.publisher = publisher;
        this.tx = tx;
        this.json = json;
    }

    /** Optimistic-concurrency config update; a stale expectedVersion conflicts (409). */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> updateConfig(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        boolean enabled, TargetingConfig newConfig, Integer expectedVersion, String comment) {
        return updateConfig(projectId, flagKey, envKey, userId, email,
            enabled, newConfig, expectedVersion, comment, WriteOrigin.DIRECT);
    }

    /** As above, stamped with the AI proposal that caused it. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> updateConfig(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        boolean enabled, TargetingConfig newConfig, Integer expectedVersion, String comment, UUID proposalId) {
        return updateConfig(projectId, flagKey, envKey, userId, email, enabled, newConfig,
            expectedVersion, comment, WriteOrigin.ofProposal(proposalId));
    }

    /**
     * As above, but stamps the version snapshot with whatever caused the write.
     * The partial unique index behind each {@link WriteOrigin} id then makes a
     * second apply of the same proposal or change request fail at the database,
     * which is the backstop behind the callers' status compare-and-set.
     */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> updateConfig(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        boolean enabled, TargetingConfig newConfig, Integer expectedVersion, String comment, WriteOrigin origin) {

        return mutate(projectId, flagKey, envKey, userId, Permission.FLAG_WRITE, (orgId, flag, env, head) -> {
            if (expectedVersion != null && head.version() != expectedVersion) {
                return Mono.error(new ConflictException(
                    "Version conflict: expected v" + expectedVersion + " but head is v" + head.version()));
            }
            validateVariationIds(flag, newConfig);
            return validateSegmentKeys(projectId, newConfig).then(Mono.defer(() -> {
                FlagEnvConfig newHead = new FlagEnvConfig(
                    flag.id(), env.id(), enabled, head.killSwitchActive(),
                    newConfig, head.version() + 1, Instant.now(), email);
                String diffJson = diff(Map.of(
                    "enabled", Map.of("from", head.enabled(), "to", enabled),
                    "configChanged", !head.config().equals(newConfig)));
                return writeVersion(orgId, projectId, flag, env, newHead, comment, email,
                    "UPDATE", head.version(), comment, diffJson, origin);
            }));
        });
    }

    /** Ignores expectedVersion by design: the kill switch must always be flippable. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> setKillSwitch(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        boolean active, String reason) {
        return setKillSwitch(projectId, flagKey, envKey, userId, email, active, reason, WriteOrigin.DIRECT);
    }

    /** As above, stamped with the AI proposal that caused it. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> setKillSwitch(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        boolean active, String reason, UUID proposalId) {
        return setKillSwitch(projectId, flagKey, envKey, userId, email, active, reason,
            WriteOrigin.ofProposal(proposalId));
    }

    /** As above, stamped with whatever caused the write. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> setKillSwitch(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        boolean active, String reason, WriteOrigin origin) {

        return mutate(projectId, flagKey, envKey, userId, Permission.FLAG_KILL, (orgId, flag, env, head) -> {
            FlagEnvConfig newHead = new FlagEnvConfig(
                flag.id(), env.id(), head.enabled(), active,
                head.config(), head.version() + 1, Instant.now(), email);
            String action = active ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF";
            String note = "kill switch " + (active ? "on" : "off");
            String diffJson = diff(Map.of(
                "killSwitchActive", Map.of("from", head.killSwitchActive(), "to", active)));
            return writeVersion(orgId, projectId, flag, env, newHead, note, email,
                action, head.version(), reason, diffJson, origin);
        });
    }

    /** Rollback re-applies an old snapshot as a NEW version (history is append-only). */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> rollback(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        int toVersion, String reason) {
        return rollback(projectId, flagKey, envKey, userId, email, toVersion, reason, WriteOrigin.DIRECT);
    }

    /** As above, stamped with the AI proposal that caused it. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> rollback(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        int toVersion, String reason, UUID proposalId) {
        return rollback(projectId, flagKey, envKey, userId, email, toVersion, reason,
            WriteOrigin.ofProposal(proposalId));
    }

    /** As above, stamped with whatever caused the write. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<EnvConfigResult> rollback(
        UUID projectId, String flagKey, String envKey, UUID userId, String email,
        int toVersion, String reason, WriteOrigin origin) {

        return mutate(projectId, flagKey, envKey, userId, Permission.FLAG_ROLLBACK, (orgId, flag, env, head) ->
            flags.findVersion(flag.id(), env.id(), toVersion)
                .switchIfEmpty(Mono.error(new NotFoundException("Version v" + toVersion + " not found")))
                .flatMap(snapshot -> {
                    FlagEnvConfig newHead = new FlagEnvConfig(
                        flag.id(), env.id(), snapshot.enabled(), snapshot.killSwitchActive(),
                        snapshot.config(), head.version() + 1, Instant.now(), email);
                    String note = "rollback to v" + toVersion;
                    String diffJson = diff(Map.of("rolledBackTo", toVersion));
                    return writeVersion(orgId, projectId, flag, env, newHead, note, email,
                        "ROLLBACK", head.version(), reason, diffJson, origin);
                }));
    }

    public Mono<VersionPage> listVersions(
        UUID projectId, String flagKey, String envKey, UUID userId, String cursor, int limit) {
        Integer beforeVersion = parseVersionCursor(cursor);
        return resolve(projectId, flagKey, envKey, userId, Permission.FLAG_READ)
            .flatMap(resolved -> flags.listVersions(
                    resolved.flag().id(), resolved.env().id(), beforeVersion, limit)
                .collectList())
            .map(items -> new VersionPage(
                items,
                items.size() == limit
                    ? Integer.toString(items.get(items.size() - 1).versionNumber())
                    : null));
    }

    public Mono<FlagEnvConfigVersion> getVersion(
        UUID projectId, String flagKey, String envKey, UUID userId, int versionNumber) {
        return resolve(projectId, flagKey, envKey, userId, Permission.FLAG_READ)
            .flatMap(resolved -> flags.findVersion(resolved.flag().id(), resolved.env().id(), versionNumber))
            .switchIfEmpty(Mono.error(new NotFoundException("Version v" + versionNumber + " not found")));
    }

    /**
     * The same coherence checks a direct write runs, exposed so a change request
     * can be refused when it is opened rather than after somebody approves it.
     */
    public Mono<Void> validateProposedConfig(UUID projectId, Flag flag, TargetingConfig config) {
        return Mono.defer(() -> {
            validateVariationIds(flag, config);
            return validateSegmentKeys(projectId, config);
        });
    }

    // ---------------------------------------------------------------- plumbing

    @FunctionalInterface
    private interface Mutation {
        Mono<CommittedWrite> apply(UUID orgId, Flag flag, Environment env, FlagEnvConfig lockedHead);
    }

    /** Result of a committed head write plus what the after-commit NOTIFY needs. */
    private record CommittedWrite(EnvConfigResult result, UUID environmentId, String flagKey, long stateVersion) {
    }

    private record Resolved(UUID orgId, Flag flag, Environment env) {
    }

    /**
     * The flag, its environment, and the caller's standing, checked at ENVIRONMENT
     * scope. Scoping the check to the environment is what makes a per-environment
     * grant mean anything: an approver on production only, or a writer on dev only,
     * resolves here through the union rule. An org-wide member is unaffected.
     */
    private Mono<Resolved> resolve(
        UUID projectId, String flagKey, String envKey, UUID userId, Permission required) {
        return environmentByKey(projectId, envKey)
            .flatMap(env -> access.requireEnvironmentPermission(env.id(), userId, required)
                .flatMap(envAccess -> flags.findByProjectAndKey(projectId, flagKey)
                    .switchIfEmpty(Mono.error(new NotFoundException("Flag not found")))
                    .map(flag -> new Resolved(envAccess.orgId(), flag, env))));
    }

    /**
     * Everything a caller needs to decide whether a write may proceed directly:
     * the topology, the environment's approval policy, and the current head
     * version. Used by the change-request gate, which has to know the base version
     * a pending request would be measured against.
     */
    public Mono<WriteTarget> resolveTarget(
        UUID projectId, String flagKey, String envKey, UUID userId, Permission required) {
        return resolve(projectId, flagKey, envKey, userId, required)
            .flatMap(resolved -> flags.findHead(resolved.env().id(), flagKey)
                .switchIfEmpty(Mono.error(new NotFoundException("Flag has no config in this environment")))
                .map(head -> new WriteTarget(
                    resolved.orgId(), resolved.flag(), resolved.env(), head.config())));
    }

    private Mono<EnvConfigResult> mutate(
        UUID projectId, String flagKey, String envKey, UUID userId, Permission required, Mutation mutation) {
        return resolve(projectId, flagKey, envKey, userId, required)
            .flatMap(resolved -> flags.lockHead(resolved.flag().id(), resolved.env().id())
                .switchIfEmpty(Mono.error(new NotFoundException("Flag has no config in this environment")))
                .flatMap(head -> mutation.apply(resolved.orgId(), resolved.flag(), resolved.env(), head))
                .as(tx::transactional)
                // AFTER commit: evict local snapshot + pg_notify, fire-and-forget.
                .doOnNext(write -> publisher.publish(write.environmentId(), write.flagKey(), write.stateVersion()))
                .map(CommittedWrite::result));
    }

    /**
     * Shared tail of every mutation, inside the transaction: update head, append
     * snapshot, audit, bump state_version. The NOTIFY happens after commit, in
     * {@link #mutate}'s doOnNext on the transactional boundary. A non-null
     * origin stamps the snapshot and can switch the audit action.
     */
    @SuppressWarnings("checkstyle:ParameterNumber")
    private Mono<CommittedWrite> writeVersion(
        UUID orgId, UUID projectId, Flag flag, Environment env, FlagEnvConfig newHead,
        String versionNote, String email, String action, int versionFrom, String reason, String diffJson,
        WriteOrigin origin) {

        FlagEnvConfigVersion snapshot = new FlagEnvConfigVersion(
            flag.id(), env.id(), newHead.version(), newHead.enabled(), newHead.killSwitchActive(),
            newHead.config(), versionNote, email, origin.proposalId(), origin.changeRequestId(), null);
        // An AI apply is audited as AI_APPLY and an approved change request as
        // CHANGE_REQUEST_APPLY, not as the hand-edit action.
        String auditAction = origin.auditAction(action);
        return flags.updateHead(newHead)
            .then(flags.insertVersionSnapshot(snapshot))
            .then(audit.insert(orgId, projectId, env.id(), flag.key(), auditAction, email,
                reason, versionFrom, newHead.version(), diffJson))
            .then(flags.bumpStateVersion(env.id()))
            .map(stateVersion -> new CommittedWrite(
                new EnvConfigResult(env.key(), newHead), env.id(), flag.key(), stateVersion));
    }

    private Mono<Environment> environmentByKey(UUID projectId, String envKey) {
        return environments.findByProject(projectId)
            .filter(env -> env.key().equals(envKey))
            .next()
            .switchIfEmpty(Mono.error(new NotFoundException("Environment not found")));
    }

    /** Every variation id referenced anywhere in the config must exist on the flag. */
    private static void validateVariationIds(Flag flag, TargetingConfig config) {
        Set<UUID> known = flag.variations().stream().map(Variation::id).collect(Collectors.toSet());
        Set<UUID> referenced = new LinkedHashSet<>();
        referenced.add(config.offVariationId());
        referenced.add(config.defaultVariationId());
        collectServe(config.fallthrough(), referenced);
        config.individualTargets().forEach(target -> referenced.add(target.variationId()));
        config.rules().forEach(rule -> collectServe(rule.serve(), referenced));
        referenced.removeAll(known);
        if (!referenced.isEmpty()) {
            throw new ValidationException("Unknown variation ids: " + referenced);
        }
    }

    private static void collectServe(RolloutOrVariation serve, Set<UUID> into) {
        if (serve.hasRollout()) {
            serve.rollout().stream().map(WeightedVariation::variationId).forEach(into::add);
        } else {
            into.add(serve.variationId());
        }
    }

    /** Every SEGMENT_MATCH / NOT_SEGMENT_MATCH key must name an existing segment. */
    private Mono<Void> validateSegmentKeys(UUID projectId, TargetingConfig config) {
        Set<String> wanted = new LinkedHashSet<>();
        config.rules().forEach(rule -> rule.clauses().stream()
            .filter(clause -> clause.op() == ClauseOp.SEGMENT_MATCH || clause.op() == ClauseOp.NOT_SEGMENT_MATCH)
            .forEach(clause -> wanted.addAll(clause.values())));
        if (wanted.isEmpty()) {
            return Mono.empty();
        }
        return segments.findByProject(projectId)
            .map(Segment::key)
            .collectList()
            .flatMap(existing -> {
                Set<String> missing = new LinkedHashSet<>(wanted);
                existing.forEach(missing::remove);
                return missing.isEmpty()
                    ? Mono.empty()
                    : Mono.error(new ValidationException("Unknown segment keys: " + missing));
            });
    }

    private static Integer parseVersionCursor(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return null;
        }
        try {
            return Integer.parseInt(cursor);
        } catch (NumberFormatException e) {
            throw new ValidationException("Malformed cursor");
        }
    }

    private String diff(Map<String, Object> fields) {
        try {
            return json.writeValueAsString(new LinkedHashMap<>(fields));
        } catch (JsonProcessingException e) {
            return null;
        }
    }
}
