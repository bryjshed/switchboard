package com.switchboard.interfaces.rest;

import com.switchboard.application.project.ProjectService;
import com.switchboard.application.project.SdkKeyService;
import com.switchboard.interfaces.rest.api.EnvironmentsApi;
import com.switchboard.interfaces.rest.mapper.TopologyMappers;
import com.switchboard.interfaces.rest.model.EnvironmentCreateRequest;
import com.switchboard.interfaces.rest.model.EnvironmentResponse;
import com.switchboard.interfaces.rest.model.EnvironmentUpdateRequest;
import com.switchboard.interfaces.rest.model.SdkKeyCreateRequest;
import com.switchboard.interfaces.rest.model.SdkKeyCreatedResponse;
import com.switchboard.interfaces.rest.model.SdkKeyResponse;
import com.switchboard.interfaces.security.Principals;
import com.switchboard.domain.project.SdkKeyKind;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
public class EnvironmentsController implements EnvironmentsApi {

    private final ProjectService projectService;
    private final SdkKeyService sdkKeyService;

    public EnvironmentsController(ProjectService projectService, SdkKeyService sdkKeyService) {
        this.projectService = projectService;
        this.sdkKeyService = sdkKeyService;
    }

    @Override
    public Mono<ResponseEntity<EnvironmentResponse>> createEnvironment(
        UUID projectId, Mono<EnvironmentCreateRequest> environmentCreateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(environmentCreateRequest)
            .flatMap(t -> projectService.createEnvironment(
                projectId, t.getT1().userId(), t.getT1().email(),
                t.getT2().getKey(), t.getT2().getName()))
            .map(env -> ResponseEntity.status(HttpStatus.CREATED)
                .body(TopologyMappers.toEnvironmentResponse(env)));
    }

    @Override
    public Mono<ResponseEntity<Flux<EnvironmentResponse>>> listEnvironments(
        UUID projectId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                projectService.listEnvironments(projectId, user.userId())
                    .map(TopologyMappers::toEnvironmentResponse)));
    }

    @Override
    public Mono<ResponseEntity<EnvironmentResponse>> updateEnvironment(
        UUID envId, Mono<EnvironmentUpdateRequest> environmentUpdateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(environmentUpdateRequest)
            .flatMap(t -> projectService.updateEnvironment(
                envId, t.getT1().userId(), t.getT1().email(),
                t.getT2().getName(), t.getT2().getArchived()))
            .map(env -> ResponseEntity.ok(TopologyMappers.toEnvironmentResponse(env)));
    }

    @Override
    public Mono<ResponseEntity<SdkKeyCreatedResponse>> createSdkKey(
        UUID envId, Mono<SdkKeyCreateRequest> sdkKeyCreateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(sdkKeyCreateRequest)
            .flatMap(t -> sdkKeyService.create(envId, t.getT1(), t.getT2().getLabel(),
                toDomainKind(t.getT2().getKind())))
            .map(created -> ResponseEntity.status(HttpStatus.CREATED)
                .body(TopologyMappers.toSdkKeyCreatedResponse(created)));
    }

    /** Absent means SERVER, which is what every caller written before client keys existed sends. */
    private static SdkKeyKind toDomainKind(
        com.switchboard.interfaces.rest.model.SdkKeyKind kind) {
        return kind == null ? SdkKeyKind.SERVER : SdkKeyKind.valueOf(kind.getValue());
    }

    @Override
    public Mono<ResponseEntity<Flux<SdkKeyResponse>>> listSdkKeys(UUID envId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                sdkKeyService.list(envId, user.userId()).map(TopologyMappers::toSdkKeyResponse)));
    }

    @Override
    public Mono<ResponseEntity<Void>> revokeSdkKey(UUID keyId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> sdkKeyService.revoke(keyId, user))
            .thenReturn(ResponseEntity.noContent().build());
    }
}
