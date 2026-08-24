package com.switchboard.interfaces.rest;

import com.switchboard.application.evaluation.EnvSnapshot;
import com.switchboard.application.evaluation.EnvSnapshotCache;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.evaluation.FlagEvaluator;
import com.switchboard.domain.flag.FlagAndConfig;
import com.switchboard.interfaces.rest.ofrep.OfrepBadRequestException;
import com.switchboard.interfaces.rest.ofrep.OfrepBulkEvaluationResponse;
import com.switchboard.interfaces.rest.ofrep.OfrepErrorCode;
import com.switchboard.interfaces.rest.ofrep.OfrepEvaluationFailure;
import com.switchboard.interfaces.rest.ofrep.OfrepEvaluationRequest;
import com.switchboard.interfaces.rest.ofrep.OfrepEvaluationSuccess;
import com.switchboard.interfaces.rest.ofrep.OfrepEventStream;
import com.switchboard.interfaces.rest.ofrep.OfrepEventStreamEndpoint;
import com.switchboard.interfaces.rest.ofrep.OfrepFlagEvaluation;
import com.switchboard.interfaces.rest.ofrep.OfrepGeneralError;
import com.switchboard.interfaces.rest.ofrep.OfrepMappers;
import com.switchboard.interfaces.security.Principals;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.ServerWebInputException;
import reactor.core.publisher.Mono;

/**
 * OFREP - the OpenFeature Remote Evaluation Protocol - over Switchboard's evaluation engine.
 *
 * <p>Implementing this protocol is what lets the six OpenFeature-maintained providers (JS client,
 * JS server, Go, Python, .NET, Java) talk to Switchboard with no Switchboard-specific code in
 * them, so conformance to the letter is the whole point: a provider that almost works is worth
 * nothing.
 *
 * <p>Deliberately a plain {@code @RestController} rather than the generated {@code OfrepApi}, the
 * same call {@link StreamController} makes and for the same reason - the generated signature
 * cannot express these responses. OFREP answers one operation with three different body schemas
 * (success, {@code evaluationFailure}, {@code flagNotFound}) and answers the bulk operation with
 * either a body or a bodiless 304, while a generated method is fixed to one response type. The
 * paths, schemas and security schemes are still spelled out in {@code switchboard-api.yaml}; only
 * the binding is by hand.
 *
 * <p>The environment comes from the SDK-key principal, never from the request, exactly as on
 * {@code /api/eval}.
 */
@RestController
public class OfrepController {

    /** Path of {@link OfrepStreamController}, advertised to providers on every bulk response. */
    public static final String STREAM_PATH = "/ofrep/v1/stream";

    /**
     * Seconds of client inactivity after which a provider should drop the SSE connection and
     * re-fetch on resume. 120 is OFREP's own default.
     */
    private static final int INACTIVITY_DELAY_SECONDS = 120;

    /**
     * Only advertised because {@link OfrepStreamController} actually serves it - an advertised but
     * broken stream is worse than none, since providers stop polling once they connect.
     */
    private static final List<OfrepEventStream> EVENT_STREAMS = List.of(
        new OfrepEventStream("sse", new OfrepEventStreamEndpoint(STREAM_PATH), INACTIVITY_DELAY_SECONDS));

    private static final Logger log = LoggerFactory.getLogger(OfrepController.class);

    private final EnvSnapshotCache snapshots;

    public OfrepController(EnvSnapshotCache snapshots) {
        this.snapshots = snapshots;
    }

    /**
     * POST /ofrep/v1/evaluate/flags/{key} - dynamic-context evaluation for server-side providers.
     *
     * <p>Unlike {@code /api/eval/{flagKey}}, an unknown flag is a 404 {@code FLAG_NOT_FOUND}: OFREP
     * providers own the code default and expect to be told the flag is missing, rather than being
     * handed a server-chosen fallback.
     */
    @PostMapping(
        value = "/ofrep/v1/evaluate/flags/{key}",
        consumes = MediaType.APPLICATION_JSON_VALUE,
        produces = MediaType.APPLICATION_JSON_VALUE)
    public Mono<ResponseEntity<Object>> evaluateFlag(
        @PathVariable("key") String key, @RequestBody Mono<OfrepEvaluationRequest> request) {

        return Principals.currentSdkKey()
            .zipWith(request)
            .flatMap(t -> {
                EvalContext context = OfrepMappers.toEvalContext(t.getT2(), key);
                return snapshots.get(t.getT1().environmentId())
                    .map(snapshot -> snapshot.flags().stream()
                        .filter(fc -> fc.flag().key().equals(key))
                        .findFirst()
                        .map(fc -> ResponseEntity.ok((Object) evaluate(snapshot, fc, context)))
                        .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                            .body(OfrepEvaluationFailure.of(key, OfrepErrorCode.FLAG_NOT_FOUND,
                                "Flag '" + key + "' was not found in environment " + snapshot.envKey()))));
            });
    }

    /**
     * POST /ofrep/v1/evaluate/flags - static-context bulk evaluation for client-side providers.
     *
     * <p>The ETag is the environment's {@code stateVersion}, quoted exactly as
     * {@code /api/eval/bootstrap} quotes it, so the two conditional endpoints agree and a provider
     * that polls a changed-nothing environment pays for headers only.
     */
    @PostMapping(
        value = "/ofrep/v1/evaluate/flags",
        consumes = MediaType.APPLICATION_JSON_VALUE,
        produces = MediaType.APPLICATION_JSON_VALUE)
    public Mono<ResponseEntity<Object>> evaluateAllFlags(
        @RequestBody Mono<OfrepEvaluationRequest> request, ServerWebExchange exchange) {

        return Principals.currentSdkKey()
            .zipWith(request)
            .flatMap(t -> {
                EvalContext context = OfrepMappers.toEvalContext(t.getT2(), null);
                return snapshots.get(t.getT1().environmentId()).map(snapshot -> {
                    String etag = etag(snapshot);
                    if (exchange.getRequest().getHeaders().getIfNoneMatch().contains(etag)) {
                        return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).build();
                    }
                    List<OfrepFlagEvaluation> flags = snapshot.flags().stream()
                        .map(fc -> (OfrepFlagEvaluation) evaluate(snapshot, fc, context))
                        .toList();
                    return ResponseEntity.ok().eTag(etag)
                        .body((Object) new OfrepBulkEvaluationResponse(flags, metadata(snapshot), EVENT_STREAMS));
                });
            });
    }

    /** The environment's monotonic change cursor, quoted as a strong ETag. */
    private static String etag(EnvSnapshot snapshot) {
        return "\"" + snapshot.stateVersion() + "\"";
    }

    private static OfrepEvaluationSuccess evaluate(
        EnvSnapshot snapshot, FlagAndConfig fc, EvalContext context) {
        return OfrepMappers.toSuccess(
            fc, FlagEvaluator.evaluate(fc.flag(), fc.config(), context, snapshot.segmentsByKey()));
    }

    /** Flag-set metadata: OFREP allows scalars only, so this is the environment cursor and key. */
    private static Map<String, Object> metadata(EnvSnapshot snapshot) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("switchboard.envKey", snapshot.envKey());
        metadata.put("switchboard.stateVersion", snapshot.stateVersion());
        return metadata;
    }

    // ---------------------------------------------------------------- errors
    // Declared on the controller so they win over GlobalExceptionHandler: OFREP defines its own
    // error bodies and an ApiError here would be unparseable to every provider.

    @ExceptionHandler(OfrepBadRequestException.class)
    public ResponseEntity<OfrepEvaluationFailure> badRequest(OfrepBadRequestException e) {
        return ResponseEntity.badRequest()
            .body(OfrepEvaluationFailure.of(e.flagKey(), e.errorCode(), e.getMessage()));
    }

    /** A body that is absent, truncated or not JSON at all. */
    @ExceptionHandler(ServerWebInputException.class)
    public ResponseEntity<OfrepEvaluationFailure> parseError(ServerWebInputException e, ServerWebExchange exchange) {
        return ResponseEntity.badRequest()
            .body(OfrepEvaluationFailure.of(flagKeyOf(exchange), OfrepErrorCode.PARSE_ERROR,
                "Request body could not be parsed as an OFREP evaluation request"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<OfrepGeneralError> unexpected(Exception e) {
        log.error("OFREP evaluation failed", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(new OfrepGeneralError("An internal error occurred while evaluating flags"));
    }

    /**
     * The flag key of a single-evaluation request, or null on the bulk endpoint - a parse failure
     * happens before argument binding, so the key has to come back off the path.
     */
    private static String flagKeyOf(ServerWebExchange exchange) {
        String path = exchange.getRequest().getPath().value();
        String prefix = "/ofrep/v1/evaluate/flags/";
        return path.startsWith(prefix) ? path.substring(prefix.length()) : null;
    }
}
