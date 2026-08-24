package com.switchboard.interfaces.rest;

import com.switchboard.application.evaluation.EnvSnapshot;
import com.switchboard.application.evaluation.EnvSnapshotCache;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.evaluation.FlagEvaluator;
import com.switchboard.interfaces.rest.api.EvaluationApi;
import com.switchboard.interfaces.rest.mapper.FlagMappers;
import com.switchboard.interfaces.rest.model.BootstrapResponse;
import com.switchboard.interfaces.rest.model.BulkEvalRequest;
import com.switchboard.interfaces.rest.model.BulkEvalResponse;
import com.switchboard.interfaces.rest.model.EvalReason;
import com.switchboard.interfaces.rest.model.EvalResult;
import com.switchboard.interfaces.rest.model.SingleEvalRequest;
import com.switchboard.interfaces.security.Principals;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/** SDK evaluation surface; the environment comes from the SDK key principal, never the request. */
@RestController
public class EvaluationController implements EvaluationApi {

    private final EnvSnapshotCache snapshots;

    public EvaluationController(EnvSnapshotCache snapshots) {
        this.snapshots = snapshots;
    }

    @Override
    public Mono<ResponseEntity<BulkEvalResponse>> evaluateAll(
        Mono<BulkEvalRequest> bulkEvalRequest, ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .zipWith(bulkEvalRequest)
            .flatMap(t -> snapshots.get(t.getT1().environmentId())
                .map(snapshot -> {
                    EvalContext context = toContext(t.getT2().getContext());
                    List<EvalResult> results = snapshot.flags().stream()
                        .map(fc -> FlagMappers.toEvalResult(
                            fc.flag().key(),
                            fc.config().version(),
                            FlagEvaluator.evaluate(fc.flag(), fc.config(), context, snapshot.segmentsByKey())))
                        .toList();
                    return ResponseEntity.ok(new BulkEvalResponse(snapshot.stateVersion(), results));
                }));
    }

    @Override
    public Mono<ResponseEntity<EvalResult>> evaluateFlag(
        String flagKey, Mono<SingleEvalRequest> singleEvalRequest, ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .zipWith(singleEvalRequest)
            .flatMap(t -> snapshots.get(t.getT1().environmentId())
                .map(snapshot -> {
                    EvalContext context = toContext(t.getT2().getContext());
                    return snapshot.flags().stream()
                        .filter(fc -> fc.flag().key().equals(flagKey))
                        .findFirst()
                        .map(fc -> FlagMappers.toEvalResult(
                            flagKey,
                            fc.config().version(),
                            FlagEvaluator.evaluate(fc.flag(), fc.config(), context, snapshot.segmentsByKey())))
                        // Unknown flag is NOT an error for SDKs: serve the request's default.
                        .orElseGet(() -> new EvalResult(
                            flagKey,
                            t.getT2().getDefault() == null ? "" : t.getT2().getDefault(),
                            EvalReason.SDK_DEFAULT));
                })
                .map(ResponseEntity::ok));
    }

    @Override
    public Mono<ResponseEntity<BootstrapResponse>> getBootstrap(String contextKey, ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .flatMap(principal -> snapshots.get(principal.environmentId()))
            .map(snapshot -> {
                String etag = "\"" + snapshot.stateVersion() + "\"";
                if (exchange.getRequest().getHeaders().getIfNoneMatch().contains(etag)) {
                    return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).<BootstrapResponse>build();
                }
                return ResponseEntity.ok().eTag(etag).body(toBootstrap(snapshot));
            });
    }

    private static BootstrapResponse toBootstrap(EnvSnapshot snapshot) {
        return FlagMappers.toBootstrapResponse(snapshot);
    }

    private static EvalContext toContext(com.switchboard.interfaces.rest.model.EvalContext rest) {
        try {
            return new EvalContext(rest.getKey(), rest.getAttributes());
        } catch (IllegalArgumentException e) {
            throw new ValidationException(e.getMessage());
        }
    }
}
