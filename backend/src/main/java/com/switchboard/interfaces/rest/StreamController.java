package com.switchboard.interfaces.rest;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.application.evaluation.EnvSnapshotCache;
import com.switchboard.application.stream.EnvironmentStreamHub;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.interfaces.rest.mapper.FlagMappers;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * SSE stream of flag changes for one environment (SDK principal).
 *
 * <p>Deliberately does NOT implement the generated StreamApi: the generated
 * signature is Mono&lt;ResponseEntity&lt;String&gt;&gt;, which cannot express an
 * infinite event stream. The path and produces stay identical to the spec; only
 * the return type deviates (Flux&lt;ServerSentEvent&gt;).
 *
 * <p><b>Server keys</b> get the protocol this has always spoken: on connect one {@code put} event
 * with the full bootstrap payload (id = stateVersion) - always fresh, which trivially honors
 * Last-Event-ID - then a {@code patch} event per changed flag, and a {@code ping} every 15s.
 *
 * <p><b>Public keys</b> get neither. They receive a {@code refetch} frame on connect and one per
 * change, carrying nothing but the stateVersion, and re-ask the evaluated bootstrap. Three reasons,
 * the first of which is disqualifying on its own:
 *
 * <ol>
 *   <li>This is a GET. It has no body, so an evaluated patch would need the caller's context in the
 *       query string - held for the entire lifetime of a long-lived connection in every access log
 *       and proxy buffer along the path.
 *   <li>Evaluating per connection is O(connections) work per write instead of O(1).
 *   <li>A config change frequently does not change a given context's value, so evaluated patches
 *       would either be noisy no-ops or need per-connection diffing.
 *   </ol>
 *
 * <p>The frame deliberately does not name the changed flag: that would leak which flag moved,
 * including flags the holder may not see at all.
 */
@RestController
public class StreamController {

    private static final Duration PING_INTERVAL = Duration.ofSeconds(15);

    private final EnvSnapshotCache snapshots;
    private final EnvironmentStreamHub hub;
    private final FlagRepository flags;
    private final ObjectMapper json;

    public StreamController(
        EnvSnapshotCache snapshots, EnvironmentStreamHub hub, FlagRepository flags, ObjectMapper json) {
        this.snapshots = snapshots;
        this.hub = hub;
        this.flags = flags;
        this.json = json;
    }

    @GetMapping(value = "/api/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> streamChanges() {
        return com.switchboard.interfaces.security.Principals.currentSdkKey()
            .flatMapMany(principal -> {
                UUID environmentId = principal.environmentId();
                return principal.isPublic()
                    ? publicStream(environmentId)
                    : serverStream(environmentId);
            });
    }

    /** The full-fidelity protocol, unchanged, for secret keys. */
    private Flux<ServerSentEvent<String>> serverStream(UUID environmentId) {
        Mono<ServerSentEvent<String>> put = snapshots.get(environmentId)
            .map(snapshot -> ServerSentEvent.<String>builder()
                .event("put")
                .id(Long.toString(snapshot.stateVersion()))
                .data(write(FlagMappers.toBootstrapResponse(snapshot)))
                .build());
        Flux<ServerSentEvent<String>> patches = hub.subscribe(environmentId)
            .concatMap(flagKey -> flags.findHead(environmentId, flagKey)
                .map(this::patchEvent)
                // A flag deleted/archived between notify and read: skip the patch.
                .onErrorResume(e -> Mono.empty()));
        return Flux.concat(put, Flux.merge(patches, pings()));
    }

    /**
     * Change notification only.
     *
     * <p>This method deliberately touches neither {@link FlagRepository} nor
     * {@code FlagMappers.toRestConfig} - the two things that could put targeting rules on the wire.
     * Keeping the branch structurally unable to reach them means the leak cannot be reintroduced by
     * a later careless edit; it would not compile.
     */
    private Flux<ServerSentEvent<String>> publicStream(UUID environmentId) {
        Mono<ServerSentEvent<String>> hello = snapshots.get(environmentId)
            .map(snapshot -> refetchEvent(snapshot.stateVersion()));
        Flux<ServerSentEvent<String>> changes = hub.subscribe(environmentId)
            .concatMap(ignoredFlagKey -> snapshots.get(environmentId)
                .map(snapshot -> refetchEvent(snapshot.stateVersion()))
                .onErrorResume(e -> Mono.empty()));
        return Flux.concat(hello, Flux.merge(changes, pings()));
    }

    private ServerSentEvent<String> refetchEvent(long stateVersion) {
        return ServerSentEvent.<String>builder()
            .event("refetch")
            .id(Long.toString(stateVersion))
            .data("{\"stateVersion\":" + stateVersion + "}")
            .build();
    }

    private Flux<ServerSentEvent<String>> pings() {
        return Flux.interval(PING_INTERVAL)
            .map(tick -> ServerSentEvent.<String>builder().event("ping").data("").build());
    }

    private ServerSentEvent<String> patchEvent(com.switchboard.domain.flag.FlagHead head) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("flagKey", head.flag().key());
        payload.put("enabled", head.config().enabled());
        payload.put("killSwitchActive", head.config().killSwitchActive());
        payload.put("config", FlagMappers.toRestConfig(head.config().config()));
        payload.put("version", head.config().version());
        payload.put("stateVersion", head.stateVersion());
        return ServerSentEvent.<String>builder()
            .event("patch")
            .id(Long.toString(head.stateVersion()))
            .data(write(payload))
            .build();
    }

    private String write(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize SSE payload", e);
        }
    }
}
