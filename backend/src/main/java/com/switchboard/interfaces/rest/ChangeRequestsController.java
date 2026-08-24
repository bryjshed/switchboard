package com.switchboard.interfaces.rest;

import com.switchboard.application.changerequest.ApprovalSettingsService;
import com.switchboard.application.changerequest.ChangeRequestReviewService;
import com.switchboard.application.changerequest.ChangeRequestService;
import com.switchboard.interfaces.rest.api.ChangeRequestsApi;
import com.switchboard.interfaces.rest.mapper.GovernanceMappers;
import com.switchboard.interfaces.rest.model.ApprovalSettingsResponse;
import com.switchboard.interfaces.rest.model.ApprovalSettingsUpdateRequest;
import com.switchboard.interfaces.rest.model.ChangeRequestDecisionRequest;
import com.switchboard.interfaces.rest.model.ChangeRequestListResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestStatus;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@RestController
public class ChangeRequestsController implements ChangeRequestsApi {

    private final ChangeRequestService changeRequests;
    private final ChangeRequestReviewService reviews;
    private final ApprovalSettingsService approvalSettings;

    public ChangeRequestsController(
        ChangeRequestService changeRequests,
        ChangeRequestReviewService reviews,
        ApprovalSettingsService approvalSettings) {
        this.changeRequests = changeRequests;
        this.reviews = reviews;
        this.approvalSettings = approvalSettings;
    }

    @Override
    public Mono<ResponseEntity<ChangeRequestListResponse>> listChangeRequests(
        UUID projectId, String envKey, String flagKey, ChangeRequestStatus status,
        String cursor, Integer limit, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> changeRequests.list(
                projectId, user.userId(), envKey, flagKey, toDomainStatus(status), cursor, limit))
            .map(page -> ResponseEntity.ok(
                new ChangeRequestListResponse(
                    page.items().stream().map(GovernanceMappers::toChangeRequestResponse).toList())
                    .nextCursor(page.nextCursor())));
    }

    @Override
    public Mono<ResponseEntity<ChangeRequestResponse>> getChangeRequest(
        UUID changeRequestId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> changeRequests.get(changeRequestId, user.userId()))
            .map(request -> ResponseEntity.ok(GovernanceMappers.toChangeRequestResponse(request)));
    }

    @Override
    public Mono<ResponseEntity<ChangeRequestResponse>> approveChangeRequest(
        UUID changeRequestId, Mono<ChangeRequestDecisionRequest> body, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(comment(body))
            .flatMap(t -> reviews.approve(changeRequestId, t.getT1(), t.getT2().value()))
            .map(request -> ResponseEntity.ok(GovernanceMappers.toChangeRequestResponse(request)));
    }

    @Override
    public Mono<ResponseEntity<ChangeRequestResponse>> declineChangeRequest(
        UUID changeRequestId, Mono<ChangeRequestDecisionRequest> body, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(comment(body))
            .flatMap(t -> reviews.decline(changeRequestId, t.getT1(), t.getT2().value()))
            .map(request -> ResponseEntity.ok(GovernanceMappers.toChangeRequestResponse(request)));
    }

    @Override
    public Mono<ResponseEntity<ChangeRequestResponse>> withdrawChangeRequest(
        UUID changeRequestId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> reviews.withdraw(changeRequestId, user))
            .map(request -> ResponseEntity.ok(GovernanceMappers.toChangeRequestResponse(request)));
    }

    @Override
    public Mono<ResponseEntity<ChangeRequestResponse>> applyChangeRequest(
        UUID changeRequestId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> reviews.applyApproved(changeRequestId, user))
            .map(request -> ResponseEntity.ok(GovernanceMappers.toChangeRequestResponse(request)));
    }

    @Override
    public Mono<ResponseEntity<ApprovalSettingsResponse>> getApprovalSettings(
        UUID envId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> approvalSettings.get(envId, user.userId()))
            .map(settings -> ResponseEntity.ok(
                GovernanceMappers.toApprovalSettingsResponse(settings)));
    }

    @Override
    public Mono<ResponseEntity<ApprovalSettingsResponse>> updateApprovalSettings(
        UUID envId, Mono<ApprovalSettingsUpdateRequest> body, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(body)
            .flatMap(t -> approvalSettings.update(
                envId, t.getT1(),
                t.getT2().getRequireApproval(),
                t.getT2().getMinApprovals(),
                t.getT2().getAllowSelfApproval(),
                t.getT2().getRequireApprovalForKill(),
                t.getT2().getAllowAutomationBypass()))
            .map(settings -> ResponseEntity.ok(
                GovernanceMappers.toApprovalSettingsResponse(settings)));
    }

    /** An absent body is a decision with no comment, so zipWith still has something to pair. */
    private record Comment(String value) {
    }

    private static Mono<Comment> comment(Mono<ChangeRequestDecisionRequest> body) {
        return body.map(request -> new Comment(request.getComment()))
            .defaultIfEmpty(new Comment(null));
    }

    private static com.switchboard.domain.changerequest.ChangeRequestStatus toDomainStatus(
        ChangeRequestStatus status) {
        return status == null
            ? null
            : com.switchboard.domain.changerequest.ChangeRequestStatus.valueOf(status.getValue());
    }
}
