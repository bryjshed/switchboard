package com.switchboard.application.project;

import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.project.Environment;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.flag.FlagEnvConfigVersion;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.flag.TargetingConfig;
import java.time.Instant;
import com.switchboard.domain.metric.MetricDefinitionRepository;
import com.switchboard.domain.project.EnvironmentRepository;
import com.switchboard.domain.project.Project;
import com.switchboard.domain.project.ProjectRepository;
import com.switchboard.domain.project.ProjectWithEnvironments;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class ProjectService {

    private static final List<Map.Entry<String, String>> SEED_ENVIRONMENTS = List.of(
        Map.entry("dev", "Development"),
        Map.entry("staging", "Staging"),
        Map.entry("production", "Production"));

    private final ProjectRepository projects;
    private final EnvironmentRepository environments;
    private final OrgAccessService access;
    private final MetricDefinitionRepository metrics;
    private final FlagRepository flags;
    private final TransactionalOperator tx;

    public ProjectService(
        ProjectRepository projects,
        EnvironmentRepository environments,
        OrgAccessService access,
        TransactionalOperator tx,
        MetricDefinitionRepository metrics,
        FlagRepository flags) {
        this.projects = projects;
        this.environments = environments;
        this.access = access;
        this.metrics = metrics;
        this.flags = flags;
        this.tx = tx;
    }

    /** Creates the project and seeds dev/staging/production in one transaction. */
    public Mono<ProjectWithEnvironments> create(UUID orgId, UUID userId, String key, String name) {
        return access.requireOrgPermission(orgId, userId, Permission.MANAGE_PROJECTS)
            .then(projects.create(orgId, key, name)
                .flatMap(project -> Flux.fromIterable(SEED_ENVIRONMENTS)
                    .concatMap(seed -> environments.create(project.id(), seed.getKey(), seed.getValue()))
                    .collectList()
                    // The two built-in metrics, in the same transaction as the project. V10
                    // seeds every project that existed when it ran; without this a project
                    // created afterwards would have none, and the rollout monitor would
                    // silently do nothing for it - indistinguishable from "no traffic yet",
                    // which is the kind of gap nobody notices for a month.
                    .flatMap(envs -> metrics.seedDefaults(project.id()).thenReturn(envs))
                    .map(envs -> new ProjectWithEnvironments(project, envs)))
                .as(tx::transactional))
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("A project with that key already exists in this org"));
    }

    public Flux<ProjectWithEnvironments> list(UUID orgId, UUID userId) {
        return access.requireMember(orgId, userId)
            .thenMany(Flux.defer(() -> projects.findByOrg(orgId)
                .collectList()
                .zipWith(environments.findByOrg(orgId).collectList())
                .flatMapMany(t -> Flux.fromIterable(t.getT1())
                    .map(project -> new ProjectWithEnvironments(
                        project,
                        t.getT2().stream().filter(e -> e.projectId().equals(project.id())).toList())))));
    }

    public Mono<ProjectWithEnvironments> get(UUID projectId, UUID userId) {
        return access.requireProjectMember(projectId, userId)
            .then(loadWithEnvironments(projectId));
    }

    public Mono<ProjectWithEnvironments> updateName(UUID projectId, UUID userId, String name) {
        return access.requireProjectPermission(projectId, userId, Permission.MANAGE_PROJECTS)
            .then(name == null ? Mono.empty() : projects.updateName(projectId, name))
            .then(loadWithEnvironments(projectId));
    }

    /**
     * Creates an environment AND gives every existing flag a configuration in it.
     *
     * <p><b>The backfill is the part that matters.</b> Creating a flag has always seeded a
     * config in every existing environment; creating an environment did not do the reverse, so
     * a new environment started with no flag configurations at all. The symptom is worse than
     * it sounds: every flag evaluated to the caller's default there, with reason
     * {@code SDK_DEFAULT} - indistinguishable from a flag that does not exist. Somebody adds
     * {@code staging-eu}, points an SDK at it, and every flag in the product silently serves
     * its fallback.
     *
     * <p>Seeded exactly as flag creation seeds a new flag - disabled, serving the default
     * variation, version 1 - through the same {@link TargetingConfig#initialFor}, so the two
     * paths cannot drift.
     *
     * <p>All in one transaction: a half-backfilled environment, where some flags are configured
     * and others silently serve defaults, is the one outcome worse than either extreme.
     */
    public Mono<Environment> createEnvironment(UUID projectId, UUID userId, String key, String name) {
        return access.requireProjectPermission(projectId, userId, Permission.MANAGE_ENVIRONMENTS)
            .then(environments.create(projectId, key, name)
                // The flag list is drained before any seeding starts. Streaming it does work -
                // that was measured, not assumed - but it means issuing a write per row against
                // an open result set on the one connection the transaction has pinned, which is
                // driver behaviour rather than anything R2DBC guarantees. A project's flag list
                // is small and read once, so buffering it costs nothing and removes the
                // question.
                .flatMap(env -> flags.findAllByProject(projectId)
                    .collectList()
                    .flatMapMany(reactor.core.publisher.Flux::fromIterable)
                    .concatMap(flag -> seedFlag(flag, env.id()))
                    .then()
                    .thenReturn(env))
                .as(tx::transactional))
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("An environment with that key already exists in this project"));
    }

    /** One flag's v1 config in a brand-new environment: head, immutable snapshot, cursor bump. */
    private Mono<Void> seedFlag(Flag flag, UUID environmentId) {
        TargetingConfig config = TargetingConfig.initialFor(flag.variations());
        if (config == null) {
            // A live flag always has at least two variations; skipping rather than failing
            // means one malformed row cannot block creating an environment.
            return Mono.empty();
        }
        FlagEnvConfig head = new FlagEnvConfig(
            flag.id(), environmentId, false, false, config, 1, Instant.now(), "system");
        FlagEnvConfigVersion snapshot = new FlagEnvConfigVersion(
            flag.id(), environmentId, 1, false, false, config,
            "environment created", "system", null, null, null);
        return flags.insertHeadConfig(head)
            .then(flags.insertVersionSnapshot(snapshot))
            .then(flags.bumpStateVersion(environmentId))
            .then();
    }

    public Flux<Environment> listEnvironments(UUID projectId, UUID userId) {
        return access.requireProjectMember(projectId, userId)
            .thenMany(Flux.defer(() -> environments.findByProject(projectId)));
    }

    private Mono<ProjectWithEnvironments> loadWithEnvironments(UUID projectId) {
        return projects.findById(projectId)
            .zipWith(environments.findByProject(projectId).collectList())
            .map(t -> new ProjectWithEnvironments(t.getT1(), t.getT2()));
    }
}
