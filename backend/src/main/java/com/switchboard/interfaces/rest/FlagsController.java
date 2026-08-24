package com.switchboard.interfaces.rest;

import com.switchboard.application.changerequest.ChangeRequestService;
import com.switchboard.application.changerequest.WriteOutcome;
import com.switchboard.application.flag.FlagService;
import com.switchboard.application.flag.FlagTargetingService;
import com.switchboard.application.flag.VariationInput;
import com.switchboard.domain.flag.FlagKind;
import com.switchboard.interfaces.rest.api.FlagsApi;
import com.switchboard.interfaces.rest.mapper.FlagMappers;
import com.switchboard.interfaces.rest.mapper.GovernanceMappers;
import com.switchboard.interfaces.rest.model.FlagCreateRequest;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagListResponse;
import com.switchboard.interfaces.rest.model.FlagUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagVersionListResponse;
import com.switchboard.interfaces.rest.model.FlagVersionResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestResponse;
import com.switchboard.interfaces.rest.model.KillSwitchRequest;
import com.switchboard.interfaces.rest.model.RollbackRequest;
import com.switchboard.interfaces.rest.model.VariationCreate;
import com.switchboard.interfaces.security.AuthenticatedUser;
import com.switchboard.interfaces.security.Principals;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@RestController
public class FlagsController implements FlagsApi {

    private final FlagService flagService;
    private final FlagTargetingService targetingService;
    private final ChangeRequestService changeRequests;

    public FlagsController(
        FlagService flagService,
        FlagTargetingService targetingService,
        ChangeRequestService changeRequests) {
        this.flagService = flagService;
        this.targetingService = targetingService;
        this.changeRequests = changeRequests;
    }

    @Override
    public Mono<ResponseEntity<FlagDetailResponse>> createFlag(
        UUID projectId, Mono<FlagCreateRequest> flagCreateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(flagCreateRequest)
            .flatMap(t -> {
                AuthenticatedUser user = t.getT1();
                FlagCreateRequest request = t.getT2();
                return flagService.create(
                    projectId, user.userId(), user.email(),
                    request.getKey(), request.getName(), request.getDescription(),
                    FlagKind.valueOf(request.getKind().name()),
                    toVariationInputs(request.getVariations()),
                    request.getTags());
            })
            .map(detail -> ResponseEntity.status(HttpStatus.CREATED)
                .body(FlagMappers.toFlagDetailResponse(detail)));
    }

    @Override
    public Mono<ResponseEntity<FlagDetailResponse>> getFlag(
        UUID projectId, String flagKey, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> flagService.get(projectId, flagKey, user.userId()))
            .map(detail -> ResponseEntity.ok(FlagMappers.toFlagDetailResponse(detail)));
    }

    @Override
    public Mono<ResponseEntity<FlagListResponse>> listFlags(
        UUID projectId, String query, String tag, String cursor, Integer limit, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> flagService.list(projectId, user.userId(), query, tag, cursor, limit))
            .map(page -> ResponseEntity.ok(
                new FlagListResponse(page.items().stream().map(FlagMappers::toSummaryResponse).toList())
                    .nextCursor(page.nextCursor())));
    }

    @Override
    public Mono<ResponseEntity<FlagDetailResponse>> updateFlag(
        UUID projectId, String flagKey, Mono<FlagUpdateRequest> flagUpdateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(flagUpdateRequest)
            .flatMap(t -> flagService.patch(
                projectId, flagKey, t.getT1().userId(), t.getT1().email(),
                t.getT2().getName(), t.getT2().getDescription(), t.getT2().getTags(),
                toVariationInputs(t.getT2().getAddVariations())))
            .map(detail -> ResponseEntity.ok(FlagMappers.toFlagDetailResponse(detail)));
    }

    @Override
    public Mono<ResponseEntity<Void>> archiveFlag(UUID projectId, String flagKey, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> flagService.archive(projectId, flagKey, user.userId(), user.email()))
            .thenReturn(ResponseEntity.noContent().build());
    }

    @Override
    public Mono<ResponseEntity<FlagEnvConfigResponse>> updateFlagEnvConfig(
        UUID projectId, String flagKey, String envKey,
        Mono<FlagEnvConfigUpdateRequest> flagEnvConfigUpdateRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(flagEnvConfigUpdateRequest)
            .flatMap(t -> changeRequests.submitTargetingUpdate(
                projectId, flagKey, envKey, t.getT1(),
                t.getT2().getEnabled(),
                FlagMappers.toDomainConfig(t.getT2().getConfig()),
                t.getT2().getExpectedVersion(),
                t.getT2().getComment()))
            .map(FlagsController::toWriteResponse);
    }

    @Override
    public Mono<ResponseEntity<FlagEnvConfigResponse>> setKillSwitch(
        UUID projectId, String flagKey, String envKey,
        Mono<KillSwitchRequest> killSwitchRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(killSwitchRequest)
            .flatMap(t -> changeRequests.submitKillSwitch(
                projectId, flagKey, envKey, t.getT1(),
                Boolean.TRUE.equals(t.getT2().getActive()), t.getT2().getReason()))
            .map(FlagsController::toWriteResponse);
    }

    @Override
    public Mono<ResponseEntity<FlagEnvConfigResponse>> rollbackFlagEnvConfig(
        UUID projectId, String flagKey, String envKey,
        Mono<RollbackRequest> rollbackRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(rollbackRequest)
            .flatMap(t -> changeRequests.submitRollback(
                projectId, flagKey, envKey, t.getT1(),
                t.getT2().getToVersion(), t.getT2().getReason()))
            .map(FlagsController::toWriteResponse);
    }

    /**
     * 200 with the new config version, or 202 with the change request that now
     * stands in for the write.
     *
     * <p>The generated interface types these methods by their 200 body, because
     * the generator picks one schema per operation. The 202 body is a different
     * shape, so it goes out through an erased cast; WebFlux serialises a
     * non-container body by its runtime type, so the wire format is exactly what
     * the spec's 202 declares. The status code, not the body, is the contract:
     * a client that only ever looked at 200 keeps working, because an environment
     * has to be deliberately switched to require approval before a 202 is possible.
     */
    @SuppressWarnings("unchecked")
    private static <T> ResponseEntity<T> toWriteResponse(WriteOutcome outcome) {
        return switch (outcome) {
            case WriteOutcome.Applied applied -> (ResponseEntity<T>) ResponseEntity.ok(
                FlagMappers.toEnvConfigResponse(applied.result().envKey(), applied.result().head()));
            case WriteOutcome.Pending pending -> {
                ChangeRequestResponse body =
                    GovernanceMappers.toChangeRequestResponse(pending.request());
                yield (ResponseEntity<T>) ResponseEntity.status(HttpStatus.ACCEPTED)
                    .header(HttpHeaders.LOCATION, "/api/change-requests/" + body.getId())
                    .body(body);
            }
        };
    }

    @Override
    public Mono<ResponseEntity<FlagVersionListResponse>> listFlagVersions(
        UUID projectId, String flagKey, String envKey, String cursor, Integer limit, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> targetingService.listVersions(
                projectId, flagKey, envKey, user.userId(), cursor, limit))
            .map(page -> ResponseEntity.ok(
                new FlagVersionListResponse(page.items().stream().map(FlagMappers::toVersionResponse).toList())
                    .nextCursor(page.nextCursor())));
    }

    @Override
    public Mono<ResponseEntity<FlagVersionResponse>> getFlagVersion(
        UUID projectId, String flagKey, String envKey, Integer versionNumber, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> targetingService.getVersion(
                projectId, flagKey, envKey, user.userId(), versionNumber))
            .map(version -> ResponseEntity.ok(FlagMappers.toVersionResponse(version)));
    }

    private static List<VariationInput> toVariationInputs(List<VariationCreate> requested) {
        return requested.stream()
            .map(v -> new VariationInput(v.getValue(), v.getName()))
            .toList();
    }
}
