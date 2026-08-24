package com.switchboard.interfaces.rest;

import com.switchboard.application.ai.AnomalyService;
import com.switchboard.application.ai.ProposalActor;
import com.switchboard.application.ai.ProposalOutcome;
import com.switchboard.application.ai.ProposalService;
import com.switchboard.application.ai.RolloutStatsService;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.AnomalyStatus;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.interfaces.rest.api.AiApi;
import com.switchboard.interfaces.rest.mapper.AiMappers;
import com.switchboard.interfaces.rest.mapper.GovernanceMappers;
import com.switchboard.interfaces.rest.model.AiProposalListResponse;
import com.switchboard.interfaces.rest.model.AiProposalResponse;
import com.switchboard.interfaces.rest.model.AnomalyFindingResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestResponse;
import com.switchboard.interfaces.rest.model.ProposalActionRequest;
import com.switchboard.interfaces.rest.model.ProposalDraftRequest;
import com.switchboard.interfaces.rest.model.RolloutStatsResponse;
import com.switchboard.interfaces.security.AuthenticatedUser;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Proposals, anomaly findings, and rollout statistics. */
@RestController
public class AiController implements AiApi {

    private final ProposalService proposals;
    private final AnomalyService anomalies;
    private final RolloutStatsService stats;
    private final FlagRepository flags;

    public AiController(
        ProposalService proposals,
        AnomalyService anomalies,
        RolloutStatsService stats,
        FlagRepository flags) {
        this.proposals = proposals;
        this.anomalies = anomalies;
        this.stats = stats;
        this.flags = flags;
    }

    @Override
    public Mono<ResponseEntity<AiProposalResponse>> draftProposal(
        UUID projectId, Mono<ProposalDraftRequest> proposalDraftRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(proposalDraftRequest)
            .flatMap(t -> proposals.draft(
                projectId, actor(t.getT1()), t.getT2().getPrompt(),
                t.getT2().getEnvironmentKey(), t.getT2().getFlagKey()))
            .flatMap(this::toResponse)
            .map(body -> ResponseEntity.status(HttpStatus.CREATED).body(body));
    }

    @Override
    public Mono<ResponseEntity<AiProposalListResponse>> listProposals(
        UUID projectId, String status, String cursor, Integer limit, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> proposals.list(projectId, actor(user), parseStatus(status), cursor, limit))
            .flatMap(page -> Flux.fromIterable(page.items())
                .concatMap(this::toResponse)
                .collectList()
                .map(items -> ResponseEntity.ok(
                    new AiProposalListResponse(items).nextCursor(page.nextCursor()))));
    }

    @Override
    public Mono<ResponseEntity<AiProposalResponse>> getProposal(UUID proposalId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> proposals.get(proposalId, actor(user)))
            .flatMap(this::toResponse)
            .map(ResponseEntity::ok);
    }

    /**
     * 200 with the applied proposal, or 202 with the change request that now
     * stands in for the apply, exactly as the flag write endpoints do. The erased
     * cast is the same trick and for the same reason: the generator types this
     * method by its 200 body, and WebFlux serialises a non-container body by its
     * runtime type, so the 202 goes out in the shape the spec declares.
     */
    @Override
    @SuppressWarnings("unchecked")
    public Mono<ResponseEntity<AiProposalResponse>> applyProposal(
        UUID proposalId, Mono<ProposalActionRequest> proposalActionRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(proposalActionRequest.defaultIfEmpty(new ProposalActionRequest()))
            .flatMap(t -> proposals.apply(proposalId, actor(t.getT1()), t.getT2().getReason()))
            .flatMap(outcome -> switch (outcome) {
                case ProposalOutcome.Applied applied -> toResponse(applied.proposal())
                    .map(ResponseEntity::ok);
                case ProposalOutcome.Pending pending -> {
                    ChangeRequestResponse body =
                        GovernanceMappers.toChangeRequestResponse(pending.request());
                    yield Mono.just((ResponseEntity<AiProposalResponse>) (ResponseEntity<?>)
                        ResponseEntity.status(HttpStatus.ACCEPTED)
                            .header(HttpHeaders.LOCATION, "/api/change-requests/" + body.getId())
                            .body(body));
                }
            });
    }

    @Override
    public Mono<ResponseEntity<AiProposalResponse>> rejectProposal(
        UUID proposalId, Mono<ProposalActionRequest> proposalActionRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> proposals.reject(proposalId, actor(user)))
            .flatMap(this::toResponse)
            .map(ResponseEntity::ok);
    }

    @Override
    public Mono<ResponseEntity<Flux<AnomalyFindingResponse>>> listAnomalies(
        UUID envId, String status, ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                anomalies.list(envId, user.userId(), parseAnomalyStatus(status))
                    .map(AiMappers::toAnomalyResponse)));
    }

    @Override
    public Mono<ResponseEntity<AnomalyFindingResponse>> ackAnomaly(
        UUID anomalyId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> anomalies.acknowledge(anomalyId, user.userId()))
            .map(finding -> ResponseEntity.ok(AiMappers.toAnomalyResponse(finding)));
    }

    @Override
    public Mono<ResponseEntity<RolloutStatsResponse>> getRolloutStats(
        UUID envId, String flagKey, Integer hours, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> stats.get(envId, flagKey, user.userId(), hours == null ? 48 : hours))
            .map(result -> ResponseEntity.ok(AiMappers.toStatsResponse(result)));
    }

    // ---------------------------------------------------------------- plumbing

    /**
     * The diff stores variation VALUES and only the fields it changes, so
     * rendering it needs the target flag with its per-environment heads. A
     * FLAG_CREATE diff has no flag yet and renders without a resolved config.
     */
    private Mono<AiProposalResponse> toResponse(AiProposal proposal) {
        return flags.findDetail(proposal.projectId(), proposal.diff().flagKey())
            .map(detail -> AiMappers.toProposalResponse(proposal, detail))
            .switchIfEmpty(Mono.fromSupplier(() -> AiMappers.toProposalResponse(proposal, null)));
    }

    private static ProposalActor actor(AuthenticatedUser user) {
        return new ProposalActor(user.userId(), user.email());
    }

    private static ProposalStatus parseStatus(String status) {
        if (status == null || status.isBlank()) {
            return null;
        }
        try {
            return ProposalStatus.valueOf(status);
        } catch (IllegalArgumentException e) {
            throw new ValidationException("Unknown proposal status: " + status);
        }
    }

    private static AnomalyStatus parseAnomalyStatus(String status) {
        if (status == null || status.isBlank()) {
            return null;
        }
        try {
            return AnomalyStatus.valueOf(status);
        } catch (IllegalArgumentException e) {
            throw new ValidationException("Unknown anomaly status: " + status);
        }
    }
}
