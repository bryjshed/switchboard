package com.switchboard.interfaces.rest;

import com.switchboard.application.segment.SegmentService;
import com.switchboard.interfaces.rest.api.SegmentsApi;
import com.switchboard.interfaces.rest.mapper.FlagMappers;
import com.switchboard.interfaces.rest.model.SegmentResponse;
import com.switchboard.interfaces.rest.model.SegmentUpsertRequest;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
public class SegmentsController implements SegmentsApi {

    private final SegmentService segmentService;

    public SegmentsController(SegmentService segmentService) {
        this.segmentService = segmentService;
    }

    @Override
    public Mono<ResponseEntity<SegmentResponse>> createSegment(
        UUID projectId, Mono<SegmentUpsertRequest> segmentUpsertRequest, ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(segmentUpsertRequest)
            .flatMap(t -> segmentService.create(
                projectId, t.getT1().userId(), t.getT1().email(),
                FlagMappers.toDomainSegment(projectId, t.getT2().getKey(), t.getT2())))
            .map(segment -> ResponseEntity.status(HttpStatus.CREATED)
                .body(FlagMappers.toSegmentResponse(segment)));
    }

    @Override
    public Mono<ResponseEntity<SegmentResponse>> getSegment(
        UUID projectId, String segmentKey, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> segmentService.get(projectId, segmentKey, user.userId()))
            .map(segment -> ResponseEntity.ok(FlagMappers.toSegmentResponse(segment)));
    }

    @Override
    public Mono<ResponseEntity<Flux<SegmentResponse>>> listSegments(UUID projectId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                segmentService.list(projectId, user.userId()).map(FlagMappers::toSegmentResponse)));
    }

    @Override
    public Mono<ResponseEntity<SegmentResponse>> updateSegment(
        UUID projectId, String segmentKey, Mono<SegmentUpsertRequest> segmentUpsertRequest,
        ServerWebExchange exchange) {
        return Principals.currentUser()
            .zipWith(segmentUpsertRequest)
            .flatMap(t -> segmentService.update(
                projectId, segmentKey, t.getT1().userId(), t.getT1().email(),
                FlagMappers.toDomainSegment(projectId, segmentKey, t.getT2())))
            .map(segment -> ResponseEntity.ok(FlagMappers.toSegmentResponse(segment)));
    }

    @Override
    public Mono<ResponseEntity<Void>> deleteSegment(
        UUID projectId, String segmentKey, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> segmentService.delete(projectId, segmentKey, user.userId(), user.email()))
            .thenReturn(ResponseEntity.noContent().build());
    }
}
