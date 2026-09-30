package com.switchboard.interfaces.rest;

import com.switchboard.application.org.InvitationService;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.application.org.OrgService;
import com.switchboard.application.settings.OrgSettings;
import com.switchboard.application.settings.OrgSettingsService;
import com.switchboard.domain.access.Permission;
import com.switchboard.interfaces.rest.api.OrgsApi;
import com.switchboard.interfaces.rest.mapper.TopologyMappers;
import com.switchboard.interfaces.rest.model.OrgCreateRequest;
import com.switchboard.interfaces.rest.model.OrgInvitationCreateRequest;
import com.switchboard.interfaces.rest.model.OrgInvitationResponse;
import com.switchboard.interfaces.rest.model.OrgMemberAddRequest;
import com.switchboard.interfaces.rest.model.OrgMemberResponse;
import com.switchboard.interfaces.rest.model.OrgResponse;
import com.switchboard.interfaces.rest.model.OrgSettingsResponse;
import com.switchboard.interfaces.rest.model.OrgSettingsUpdateRequest;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
public class OrgsController implements OrgsApi {

    private final OrgService orgService;
    private final OrgAccessService orgAccess;
    private final OrgSettingsService orgSettings;
    private final InvitationService invitations;

    public OrgsController(
        OrgService orgService,
        OrgAccessService orgAccess,
        OrgSettingsService orgSettings,
        InvitationService invitations) {
        this.orgService = orgService;
        this.orgAccess = orgAccess;
        this.orgSettings = orgSettings;
        this.invitations = invitations;
    }

    @Override
    public Mono<ResponseEntity<OrgResponse>> createOrg(
        Mono<OrgCreateRequest> orgCreateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(orgCreateRequest)
            .flatMap(t -> orgService.createOrg(t.getT2().getName(), t.getT1().userId()))
            .map(org -> ResponseEntity.status(HttpStatus.CREATED).body(TopologyMappers.toOrgResponse(org)));
    }

    @Override
    public Mono<ResponseEntity<Flux<OrgResponse>>> listOrgs(ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                orgService.listOrgs(user.userId()).map(TopologyMappers::toOrgResponse)));
    }

    @Override
    public Mono<ResponseEntity<OrgResponse>> getOrg(UUID orgId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> orgService.getOrg(orgId, user.userId()))
            .map(org -> ResponseEntity.ok(TopologyMappers.toOrgResponse(org)));
    }

    @Override
    public Mono<ResponseEntity<Flux<OrgMemberResponse>>> listOrgMembers(UUID orgId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                orgService.listMembers(orgId, user.userId()).map(TopologyMappers::toMemberResponse)));
    }

    @Override
    public Mono<ResponseEntity<OrgMemberResponse>> addOrgMember(
        UUID orgId, Mono<OrgMemberAddRequest> orgMemberAddRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(orgMemberAddRequest)
            .flatMap(t -> orgService.addMember(
                orgId, t.getT1(), t.getT2().getEmail(), t.getT2().getRole().getValue()))
            .map(member -> ResponseEntity.status(HttpStatus.CREATED)
                .body(TopologyMappers.toMemberResponse(member)));
    }

    @Override
    public Mono<ResponseEntity<Void>> removeOrgMember(UUID orgId, UUID userId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> orgService.removeMember(orgId, user, userId))
            .thenReturn(ResponseEntity.noContent().build());
    }

    @Override
    public Mono<ResponseEntity<OrgInvitationResponse>> createOrgInvitation(
        UUID orgId, Mono<OrgInvitationCreateRequest> orgInvitationCreateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(orgInvitationCreateRequest)
            .flatMap(t -> invitations.invite(
                orgId, t.getT1(), t.getT2().getEmail(), t.getT2().getRole().getValue()))
            .map(invitation -> ResponseEntity.status(HttpStatus.CREATED)
                .body(TopologyMappers.toInvitationResponse(invitation)));
    }

    @Override
    public Mono<ResponseEntity<Flux<OrgInvitationResponse>>> listOrgInvitations(
        UUID orgId, ServerWebExchange exchange) {
        // Resolved before the ResponseEntity is built, so a 403 is a 403 rather than a 200 whose
        // body stream fails part-way.
        return Principals.currentUser()
            .flatMap(user -> invitations.listPending(orgId, user).collectList())
            .map(list -> ResponseEntity.ok(Flux.fromIterable(list).map(TopologyMappers::toInvitationResponse)));
    }

    @Override
    public Mono<ResponseEntity<Void>> revokeOrgInvitation(
        UUID orgId, UUID invitationId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> invitations.revoke(orgId, user, invitationId))
            .thenReturn(ResponseEntity.noContent().build());
    }

    @Override
    public Mono<ResponseEntity<OrgSettingsResponse>> getOrgSettings(UUID orgId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> orgAccess.requireMember(orgId, user.userId()))
            .then(Mono.defer(() -> orgSettings.get(orgId)))
            .map(settings -> ResponseEntity.ok(toSettingsResponse(settings)));
    }

    @Override
    public Mono<ResponseEntity<OrgSettingsResponse>> updateOrgSettings(
        UUID orgId, Mono<OrgSettingsUpdateRequest> orgSettingsUpdateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> orgAccess.requireOrgPermission(orgId, user.userId(), Permission.MANAGE_SETTINGS)
                .then(orgSettingsUpdateRequest)
                .flatMap(req -> orgSettings.update(
                    orgId,
                    req.getAiEnabled(),
                    req.getAutoRollbackEnabled(),
                    req.getAutoOptimizeEnabled(),
                    req.getStaleFlagWeeks(),
                    req.getNotificationWebhookUrl(),
                    user.email())))
            .map(settings -> ResponseEntity.ok(toSettingsResponse(settings)));
    }

    private static OrgSettingsResponse toSettingsResponse(OrgSettings settings) {
        return new OrgSettingsResponse(
            settings.aiEnabled(), settings.autoRollbackEnabled(),
            settings.autoOptimizeEnabled(), settings.staleFlagWeeks())
            .notificationWebhookSet(settings.notificationWebhookSet());
    }
}
