package com.switchboard.interfaces.rest;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.application.evaluation.EnvSnapshot;
import com.switchboard.application.evaluation.EnvSnapshotCache;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.evaluation.FlagEvaluator;
import com.switchboard.interfaces.rest.api.EvaluationApi;
import com.switchboard.interfaces.rest.mapper.AttributeMappers;
import com.switchboard.interfaces.rest.mapper.FlagMappers;
import com.switchboard.interfaces.rest.model.BootstrapResponse;
import com.switchboard.interfaces.rest.model.BulkEvalRequest;
import com.switchboard.interfaces.rest.model.ClientBootstrapFlag;
import com.switchboard.interfaces.rest.model.ClientBootstrapRequest;
import com.switchboard.interfaces.rest.model.ClientBootstrapResponse;
import com.switchboard.interfaces.rest.model.BulkEvalResponse;
import com.switchboard.interfaces.rest.model.EvalReason;
import com.switchboard.interfaces.rest.model.EvalResult;
import com.switchboard.interfaces.rest.model.SingleEvalRequest;
import com.switchboard.interfaces.security.Principals;
import com.switchboard.interfaces.security.SwitchboardAuthenticationManager;
import java.util.List;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/** SDK evaluation surface; the environment comes from the SDK key principal, never the request. */
@RestController
public class EvaluationController implements EvaluationApi {

    private final EnvSnapshotCache snapshots;
    private final ObjectMapper json;

    public EvaluationController(EnvSnapshotCache snapshots, ObjectMapper json) {
        this.snapshots = snapshots;
        this.json = json;
    }

    @Override
    public Mono<ResponseEntity<BulkEvalResponse>> evaluateAll(
        Mono<BulkEvalRequest> bulkEvalRequest, ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .zipWith(bulkEvalRequest)
            .flatMap(t -> snapshots.get(t.getT1().environmentId())
                .map(full -> full.visibleTo(t.getT1().kind()))
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
                .map(full -> full.visibleTo(t.getT1().kind()))
                .map(snapshot -> {
                    EvalContext context = toContext(t.getT2().getContext());
                    // A flag this key may not see is indistinguishable from one that does not
                    // exist: same default, same SDK_DEFAULT reason. Anything else would confirm
                    // its existence, which is the fact being protected.
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

    /**
     * The rule-set bootstrap, for SERVER keys only.
     *
     * <p>A public key gets 403 rather than a reduced payload. A silently smaller response is how an
     * SDK ends up with an empty config store and serves defaults forever with nothing surfaced;
     * failing loudly puts the problem at integration time, which is when it can be fixed.
     */
    @Override
    public Mono<ResponseEntity<BootstrapResponse>> getBootstrap(ServerWebExchange exchange) {
        return Principals.currentSdkKey()
            .flatMap(principal -> {
                if (principal.isPublic()) {
                    return Mono.error(new ForbiddenException(
                        "A client-side SDK key cannot read the rule set. "
                            + "Use POST /api/eval/bootstrap, which returns evaluated values."));
                }
                return snapshots.get(principal.environmentId());
            })
            .map(snapshot -> {
                String etag = "\"" + snapshot.stateVersion() + "\"";
                if (exchange.getRequest().getHeaders().getIfNoneMatch().contains(etag)) {
                    return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).<BootstrapResponse>build();
                }
                return ResponseEntity.ok().eTag(etag).body(toBootstrap(snapshot));
            });
    }

    /**
     * The evaluated bootstrap: values, not rules.
     *
     * <p>Open to every key kind - a server key may legitimately want server-side evaluation - but
     * it is what a public key must use, and the payload it produces carries no targeting
     * configuration and no segment membership at all.
     *
     * <p><b>The ETag is a digest of the serialized body</b>, not the environment's stateVersion.
     * That is not belt-and-braces, it is the only correct answer once the payload depends on the
     * caller's context: at one stateVersion two different contexts produce two different bodies, so
     * a stateVersion ETag would let a shared cache serve one user's evaluated flags to another, and
     * a user whose attributes change would be told 304 and keep stale answers indefinitely.
     * Rendering the body to answer a 304 costs CPU, not bandwidth, and evaluation here runs
     * in-memory over an already-cached snapshot.
     */
    @Override
    public Mono<ResponseEntity<ClientBootstrapResponse>> getClientBootstrap(
        Mono<ClientBootstrapRequest> clientBootstrapRequest, ServerWebExchange exchange) {

        return Principals.currentSdkKey()
            .zipWith(clientBootstrapRequest)
            .flatMap(t -> snapshots.get(t.getT1().environmentId())
                .map(full -> full.visibleTo(t.getT1().kind()))
                .map(snapshot -> {
                    EvalContext context = toContext(t.getT2().getContext());
                    ClientBootstrapResponse body = toClientBootstrap(snapshot, context);
                    String etag = bodyDigestEtag(body);

                    ResponseEntity.BodyBuilder response = ResponseEntity.ok()
                        .eTag(etag)
                        // Belt and braces alongside the body-digest ETag: no shared cache should
                        // hold a per-user body at all.
                        .cacheControl(CacheControl.noStore().cachePrivate())
                        .header(HttpHeaders.VARY, HttpHeaders.AUTHORIZATION);

                    if (exchange.getRequest().getHeaders().getIfNoneMatch().contains(etag)) {
                        return ResponseEntity.status(HttpStatus.NOT_MODIFIED)
                            .eTag(etag)
                            .cacheControl(CacheControl.noStore().cachePrivate())
                            .header(HttpHeaders.VARY, HttpHeaders.AUTHORIZATION)
                            .<ClientBootstrapResponse>build();
                    }
                    return response.body(body);
                }));
    }

    private ClientBootstrapResponse toClientBootstrap(EnvSnapshot snapshot, EvalContext context) {
        List<ClientBootstrapFlag> flags = snapshot.flags().stream()
            .map(fc -> FlagMappers.toClientBootstrapFlag(
                fc, FlagEvaluator.evaluate(fc.flag(), fc.config(), context, snapshot.segmentsByKey())))
            .toList();
        return new ClientBootstrapResponse(
            snapshot.envKey(), snapshot.stateVersion(), contextHash(context), flags);
    }

    /**
     * Hex SHA-256 of the canonicalised context, echoed so a client can prove a payload belongs to
     * the context it sent - the guard against applying a 304 across a setContext().
     *
     * <p>The leading scheme byte lets the canonicalisation change later without silently colliding
     * with hashes produced by the old one.
     */
    private static String contextHash(EvalContext context) {
        StringBuilder canonical = new StringBuilder("v1\u0000").append(context.key());
        new java.util.TreeMap<>(context.attributes()).forEach((name, value) ->
            canonical.append('\u0000').append(name).append('\u0000').append(value));
        return SwitchboardAuthenticationManager.sha256(canonical.toString());
    }

    private String bodyDigestEtag(ClientBootstrapResponse body) {
        try {
            return "\"" + SwitchboardAuthenticationManager.sha256(json.writeValueAsString(body)) + "\"";
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize client bootstrap", e);
        }
    }

    private static BootstrapResponse toBootstrap(EnvSnapshot snapshot) {
        return FlagMappers.toBootstrapResponse(snapshot);
    }

    private static EvalContext toContext(com.switchboard.interfaces.rest.model.EvalContext rest) {
        try {
            return new EvalContext(
                rest.getKey(), AttributeMappers.toAttributes(rest.getAttributes()));
        } catch (IllegalArgumentException e) {
            throw new ValidationException(e.getMessage());
        }
    }
}
