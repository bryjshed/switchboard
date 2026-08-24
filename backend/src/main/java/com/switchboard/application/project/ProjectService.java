package com.switchboard.application.project;

import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.project.Environment;
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
    private final TransactionalOperator tx;

    public ProjectService(
        ProjectRepository projects,
        EnvironmentRepository environments,
        OrgAccessService access,
        TransactionalOperator tx) {
        this.projects = projects;
        this.environments = environments;
        this.access = access;
        this.tx = tx;
    }

    /** Creates the project and seeds dev/staging/production in one transaction. */
    public Mono<ProjectWithEnvironments> create(UUID orgId, UUID userId, String key, String name) {
        return access.requireOrgPermission(orgId, userId, Permission.MANAGE_PROJECTS)
            .then(projects.create(orgId, key, name)
                .flatMap(project -> Flux.fromIterable(SEED_ENVIRONMENTS)
                    .concatMap(seed -> environments.create(project.id(), seed.getKey(), seed.getValue()))
                    .collectList()
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

    public Mono<Environment> createEnvironment(UUID projectId, UUID userId, String key, String name) {
        return access.requireProjectPermission(projectId, userId, Permission.MANAGE_ENVIRONMENTS)
            .then(environments.create(projectId, key, name))
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("An environment with that key already exists in this project"));
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
