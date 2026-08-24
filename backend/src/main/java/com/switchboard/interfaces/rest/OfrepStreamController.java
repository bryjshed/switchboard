package com.switchboard.interfaces.rest;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.application.evaluation.EnvSnapshotCache;
import com.switchboard.application.stream.EnvironmentStreamHub;
import com.switchboard.interfaces.rest.ofrep.OfrepSseEventData;
import com.switchboard.interfaces.security.Principals;
import java.time.Duration;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * OFREP change-notification stream, advertised by {@link OfrepController} as
 * {@code eventStreams[0]} on every bulk response.
 *
 * <p>A provider that connects here stops polling, so this endpoint riding the same
 * {@link EnvironmentStreamHub} + {@code PgNotifyListener} path as {@code /api/stream} is not a
 * detail: one Postgres LISTEN feeds both, and an OFREP client and a native SDK client observe the
 * same change at the same moment. There is no second notification path to keep in step.
 *
 * <p>Like {@link StreamController} this does not implement the generated interface: an infinite
 * {@code Flux<ServerSentEvent>} is not expressible as {@code Mono<ResponseEntity<String>>}.
 *
 * <p>Protocol: an unnamed (default {@code message}) event per change carrying
 * {@code {"type":"refetchEvaluation","etag":"\"<stateVersion>\""}}, plus an SSE comment every 30s.
 * OFREP requires the event name to be {@code message} and the type to be read out of the payload,
 * and the keepalive is a comment rather than a named event precisely so it is invisible to
 * {@code onmessage} and can never be mistaken for a change.
 */
@RestController
public class OfrepStreamController {

    /** Well under the 120s inactivityDelaySec advertised on the bulk response. */
    private static final Duration KEEPALIVE_INTERVAL = Duration.ofSeconds(30);

    private final EnvSnapshotCache snapshots;
    private final EnvironmentStreamHub hub;
    private final ObjectMapper json;

    public OfrepStreamController(EnvSnapshotCache snapshots, EnvironmentStreamHub hub, ObjectMapper json) {
        this.snapshots = snapshots;
        this.hub = hub;
        this.json = json;
    }

    @GetMapping(value = OfrepController.STREAM_PATH, produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> streamChanges() {
        return Principals.currentSdkKey()
            .flatMapMany(principal -> {
                UUID environmentId = principal.environmentId();
                Flux<ServerSentEvent<String>> changes = hub.subscribe(environmentId)
                    // The notify listener evicts the snapshot before it publishes here, so this
                    // read always sees the state_version the change produced.
                    .concatMap(flagKey -> snapshots.get(environmentId)
                        .map(snapshot -> refetch(snapshot.stateVersion()))
                        .onErrorResume(e -> Mono.empty()));
                Flux<ServerSentEvent<String>> keepalives = Flux.interval(KEEPALIVE_INTERVAL)
                    .map(tick -> ServerSentEvent.<String>builder().comment("keepalive").build());
                return Flux.merge(changes, keepalives);
            });
    }

    private ServerSentEvent<String> refetch(long stateVersion) {
        String etag = "\"" + stateVersion + "\"";
        return ServerSentEvent.<String>builder()
            .id(Long.toString(stateVersion))
            .data(write(new OfrepSseEventData(OfrepSseEventData.REFETCH_EVALUATION, etag)))
            .build();
    }

    private String write(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize OFREP SSE payload", e);
        }
    }
}
