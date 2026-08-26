package com.switchboard.sdk.internal;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Optional;
import java.util.function.Consumer;

/**
 * HTTP against the Switchboard API: the conditional bootstrap and the SSE change stream.
 *
 * <p>{@code java.net.http} rather than a client dependency. An SDK that pins a version of
 * OkHttp or Netty picks a fight with whatever the host application already uses, and the JDK
 * client does both jobs here - it streams a response body, which is all SSE needs.
 */
public final class Transport {

    /** Result of a conditional bootstrap fetch. */
    public sealed interface BootstrapResult {
        /** A new payload, with the ETag to send next time. */
        record Fresh(JsonNode body, String etag) implements BootstrapResult {
        }

        /** The server confirmed what we already hold. */
        record NotModified() implements BootstrapResult {
        }

        /** Something went wrong. The caller keeps serving the snapshot it already has. */
        record Failed(int status, String message) implements BootstrapResult {
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    private final HttpClient http;
    private final URI baseUri;
    private final String sdkKey;
    private final Duration requestTimeout;

    public Transport(URI baseUri, String sdkKey, Duration requestTimeout) {
        this.baseUri = baseUri;
        this.sdkKey = sdkKey;
        this.requestTimeout = requestTimeout;
        this.http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();
    }

    /**
     * {@code GET /api/eval/bootstrap}, sending {@code If-None-Match} when we hold an ETag.
     *
     * <p>A 304 is the steady state and costs almost nothing on either side; it is why the
     * poll interval can be short without the poll being expensive.
     */
    public BootstrapResult fetchBootstrap(String etag) {
        HttpRequest.Builder request = HttpRequest.newBuilder()
            .uri(baseUri.resolve("/api/eval/bootstrap"))
            .timeout(requestTimeout)
            .header("Authorization", "Bearer " + sdkKey)
            .header("Accept", "application/json")
            .GET();
        if (etag != null && !etag.isBlank()) {
            request.header("If-None-Match", etag);
        }
        try {
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();
            if (status == 304) {
                return new BootstrapResult.NotModified();
            }
            if (status == 200) {
                return new BootstrapResult.Fresh(
                    JSON.readTree(response.body()),
                    response.headers().firstValue("etag").orElse(null));
            }
            if (status == 403) {
                // The rule-set bootstrap is server-keys-only, and a client key is refused
                // loudly rather than handed a reduced payload - a silently smaller response
                // is how an SDK ends up serving defaults forever with nothing surfaced.
                return new BootstrapResult.Failed(status,
                    "403 from the bootstrap: this looks like a CLIENT-side key (sb_cli_/sb_mob_). "
                        + "Local evaluation needs a SERVER key (sb_srv_).");
            }
            if (status == 401) {
                return new BootstrapResult.Failed(status, "401: the SDK key was rejected (revoked or wrong environment).");
            }
            if (status == 429) {
                String retry = response.headers().firstValue("retry-after").orElse("unknown");
                return new BootstrapResult.Failed(status, "429 rate limited; Retry-After: " + retry);
            }
            return new BootstrapResult.Failed(status, "HTTP " + status);
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return new BootstrapResult.Failed(0, e.toString());
        }
    }

    /**
     * Opens {@code GET /api/stream} and hands each complete SSE event to {@code onEvent}.
     * Blocks until the stream ends or the thread is interrupted; the caller owns reconnection.
     *
     * <p>{@code Last-Event-ID} carries the environment's stateVersion, so a reconnect after a
     * blip asks for catch-up rather than a full resend.
     */
    public void streamChanges(String lastEventId, Consumer<SseEvent> onEvent) throws IOException, InterruptedException {
        HttpRequest.Builder request = HttpRequest.newBuilder()
            .uri(baseUri.resolve("/api/stream"))
            // No timeout: an idle SSE stream is healthy, and the 15s server heartbeat plus
            // the staleness clock are what actually detect a dead one.
            .header("Authorization", "Bearer " + sdkKey)
            .header("Accept", "text/event-stream")
            .GET();
        if (lastEventId != null && !lastEventId.isBlank()) {
            request.header("Last-Event-ID", lastEventId);
        }
        HttpResponse<InputStream> response = http.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() != 200) {
            response.body().close();
            throw new IOException("stream refused with HTTP " + response.statusCode());
        }
        try (InputStream body = response.body()) {
            SseParser.parse(body, onEvent);
        }
    }

    /** One server-sent event. */
    public record SseEvent(String id, String event, String data) {
        public Optional<String> idValue() {
            return Optional.ofNullable(id);
        }
    }

    public static ObjectMapper json() {
        return JSON;
    }
}
