package com.switchboard.interfaces.rest;

import com.switchboard.application.access.AccessAdminService;
import com.switchboard.domain.access.ScopeType;
import com.switchboard.interfaces.rest.api.AccessApi;
import com.switchboard.interfaces.rest.mapper.GovernanceMappers;
import com.switchboard.interfaces.rest.model.MyPermissionsResponse;
import com.switchboard.interfaces.rest.model.RoleAssignmentCreateRequest;
import com.switchboard.interfaces.rest.model.RoleAssignmentListResponse;
import com.switchboard.interfaces.rest.model.RoleAssignmentResponse;
import com.switchboard.interfaces.rest.model.RoleListResponse;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@RestController
public class AccessController implements AccessApi {

    private final AccessAdminService accessAdmin;

    public AccessController(AccessAdminService accessAdmin) {
        this.accessAdmin = accessAdmin;
    }

    @Override
    public Mono<ResponseEntity<RoleListResponse>> listRoles(ServerWebExchange exchange) {
        return accessAdmin.listRoles()
            .map(GovernanceMappers::toRoleResponse)
            .collectList()
            .map(roles -> ResponseEntity.ok(new RoleListResponse(roles)));
    }

    @Override
    public Mono<ResponseEntity<RoleAssignmentListResponse>> listRoleAssignments(
        UUID orgId, com.switchboard.interfaces.rest.model.ScopeType scopeType, UUID scopeId,
        ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMapMany(user -> accessAdmin.listAssignments(
                orgId, user.userId(), toDomainScopeType(scopeType), scopeId))
            .map(GovernanceMappers::toAssignmentResponse)
            .collectList()
            .map(items -> ResponseEntity.ok(new RoleAssignmentListResponse(items)));
    }

    @Override
    public Mono<ResponseEntity<RoleAssignmentResponse>> grantRole(
        UUID orgId, Mono<RoleAssignmentCreateRequest> roleAssignmentCreateRequest,
        ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(roleAssignmentCreateRequest)
            .flatMap(t -> accessAdmin.grant(
                orgId, t.getT1(), t.getT2().getUserId(), t.getT2().getEmail(),
                toDomainScopeType(t.getT2().getScopeType()), t.getT2().getScopeId(),
                t.getT2().getRoleKey()))
            .map(assignment -> ResponseEntity.status(HttpStatus.CREATED)
                .body(GovernanceMappers.toAssignmentResponse(assignment)));
    }

    @Override
    public Mono<ResponseEntity<Void>> revokeRole(UUID orgId, UUID assignmentId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> accessAdmin.revoke(orgId, user, assignmentId))
            .thenReturn(ResponseEntity.noContent().build());
    }

    @Override
    public Mono<ResponseEntity<MyPermissionsResponse>> getMyPermissions(
        UUID orgId, UUID projectId, UUID envId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> accessAdmin.permissionsOf(user.userId(), orgId, projectId, envId))
            .map(scoped -> ResponseEntity.ok(toResponse(scoped)));
    }

    private static MyPermissionsResponse toResponse(AccessAdminService.ScopedPermissions scoped) {
        MyPermissionsResponse response = new MyPermissionsResponse(
            com.switchboard.interfaces.rest.model.ScopeType.fromValue(scoped.scope().type().name()),
            scoped.scope().id(),
            GovernanceMappers.toRestPermissions(scoped.permissions()));
        return switch (scoped.scope().type()) {
            case ORG -> response.orgId(scoped.scope().id());
            case PROJECT -> response.projectId(scoped.scope().id());
            case ENVIRONMENT -> response.environmentId(scoped.scope().id());
        };
    }

    private static ScopeType toDomainScopeType(
        com.switchboard.interfaces.rest.model.ScopeType scopeType) {
        return scopeType == null ? null : ScopeType.valueOf(scopeType.getValue());
    }
}
