package com.switchboard.interfaces.rest;

import com.switchboard.application.project.ProjectService;
import com.switchboard.interfaces.rest.api.ProjectsApi;
import com.switchboard.interfaces.rest.mapper.TopologyMappers;
import com.switchboard.interfaces.rest.model.ProjectCreateRequest;
import com.switchboard.interfaces.rest.model.ProjectResponse;
import com.switchboard.interfaces.rest.model.ProjectUpdateRequest;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
public class ProjectsController implements ProjectsApi {

    private final ProjectService projectService;

    public ProjectsController(ProjectService projectService) {
        this.projectService = projectService;
    }

    @Override
    public Mono<ResponseEntity<ProjectResponse>> createProject(
        UUID orgId, Mono<ProjectCreateRequest> projectCreateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(projectCreateRequest)
            .flatMap(t -> projectService.create(orgId, t.getT1().userId(), t.getT2().getKey(), t.getT2().getName()))
            .map(project -> ResponseEntity.status(HttpStatus.CREATED)
                .body(TopologyMappers.toProjectResponse(project)));
    }

    @Override
    public Mono<ResponseEntity<Flux<ProjectResponse>>> listProjects(UUID orgId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                projectService.list(orgId, user.userId()).map(TopologyMappers::toProjectResponse)));
    }

    @Override
    public Mono<ResponseEntity<ProjectResponse>> getProject(UUID projectId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> projectService.get(projectId, user.userId()))
            .map(project -> ResponseEntity.ok(TopologyMappers.toProjectResponse(project)));
    }

    @Override
    public Mono<ResponseEntity<ProjectResponse>> updateProject(
        UUID projectId, Mono<ProjectUpdateRequest> projectUpdateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(projectUpdateRequest)
            .flatMap(t -> projectService.updateName(projectId, t.getT1().userId(), t.getT2().getName()))
            .map(project -> ResponseEntity.ok(TopologyMappers.toProjectResponse(project)));
    }
}
