package com.switchboard.interfaces.rest;

import com.switchboard.application.audit.AuditQueryService;
import com.switchboard.interfaces.rest.api.AuditApi;
import com.switchboard.interfaces.rest.mapper.FlagMappers;
import com.switchboard.interfaces.rest.model.AuditListResponse;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@RestController
public class AuditController implements AuditApi {

    private final AuditQueryService auditQueryService;

    public AuditController(AuditQueryService auditQueryService) {
        this.auditQueryService = auditQueryService;
    }

    @Override
    public Mono<ResponseEntity<AuditListResponse>> listProjectAudit(
        UUID projectId, String env, String flagKey, String cursor, Integer limit, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> auditQueryService.listProject(projectId, user.userId(), env, flagKey, cursor, limit))
            .map(page -> ResponseEntity.ok(
                new AuditListResponse(page.items().stream().map(FlagMappers::toAuditEntryResponse).toList())
                    .nextCursor(page.nextCursor())));
    }

    @Override
    public Mono<ResponseEntity<AuditListResponse>> listOrgAudit(
        UUID orgId, String cursor, Integer limit, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> auditQueryService.listOrg(orgId, user.userId(), cursor, limit))
            .map(page -> ResponseEntity.ok(
                new AuditListResponse(page.items().stream().map(FlagMappers::toAuditEntryResponse).toList())
                    .nextCursor(page.nextCursor())));
    }
}
