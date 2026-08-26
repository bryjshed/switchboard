package com.switchboard.application.webhook;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.webhook.DeliveryStatus;
import com.switchboard.domain.webhook.Webhook;
import com.switchboard.domain.webhook.WebhookDelivery;
import com.switchboard.domain.webhook.WebhookRepository;
import com.switchboard.domain.webhook.WebhookSigner;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Fans an event out to the webhooks that want it, then delivers.
 *
 * <h2>Enqueue and deliver are separate on purpose</h2>
 *
 * <p>{@link #enqueue} writes outbox rows and is meant to be called INSIDE the caller's
 * transaction, so an event cannot be lost by the process dying between the flag write
 * committing and the notification being recorded - which is exactly the moment somebody most
 * wants to know what changed. {@link #deliverNow} runs after commit, and {@link #sweep} picks
 * up anything it could not complete.
 *
 * <p>Delivery failures never propagate. A broken receiver must not fail the flag write that
 * caused the event, and by the time delivery is attempted that write has already committed
 * anyway - throwing here could only mislead the caller.
 */
@Service
public class WebhookDispatcher {

    private static final Logger log = LoggerFactory.getLogger(WebhookDispatcher.class);

    private final WebhookRepository webhooks;
    private final ObjectMapper json;
    private final WebClient webClient;
    private final Duration timeout;
    private final int sweepBatch;

    public WebhookDispatcher(
        WebhookRepository webhooks,
        ObjectMapper json,
        @Value("${switchboard.webhooks.timeout-seconds:5}") int timeoutSeconds,
        @Value("${switchboard.webhooks.sweep-batch:100}") int sweepBatch) {
        this.webhooks = webhooks;
        this.json = json;
        this.webClient = WebClient.create();
        this.timeout = Duration.ofSeconds(timeoutSeconds);
        this.sweepBatch = sweepBatch;
    }

    /**
     * Writes an outbox row per matching webhook. Returns the rows so the caller can hand them
     * to {@link #deliverNow} after its transaction commits.
     *
     * <p>Returns an empty list - and touches nothing - when the org has no webhooks, which is
     * the overwhelmingly common case and keeps this off the cost of an ordinary flag write.
     */
    public Mono<List<WebhookDelivery>> enqueue(WebhookEvent event) {
        return webhooks.findEnabledForOrg(event.orgId())
            .filter(hook -> hook.matches(event.type(), event.projectId(), event.environmentId()))
            .collectList()
            .flatMap(matching -> {
                if (matching.isEmpty()) {
                    return Mono.just(List.<WebhookDelivery>of());
                }
                String payload = serialise(event);
                Instant now = Instant.now();
                List<WebhookDelivery> rows = matching.stream()
                    .map(hook -> new WebhookDelivery(
                        UUID.randomUUID(), hook.id(), event.eventId(), event.type(), payload,
                        DeliveryStatus.PENDING, 0, null, null, now, now, null))
                    .toList();
                return webhooks.enqueue(rows).thenReturn(rows);
            })
            .onErrorResume(e -> {
                // Enqueue failing is a database problem, not a receiver problem. It is logged
                // rather than propagated because the alternative is a webhook table outage
                // taking flag writes down with it.
                log.warn("Webhook enqueue failed for event {}: {}", event.type().wireName(), e.toString());
                return Mono.just(List.of());
            });
    }

    /** First attempt, after commit. Anything that fails here is left for {@link #sweep}. */
    public void deliverNow(List<WebhookDelivery> deliveries) {
        if (deliveries.isEmpty()) {
            return;
        }
        Flux.fromIterable(deliveries)
            .flatMap(delivery -> webhooks.findById(delivery.webhookId())
                .flatMap(hook -> attempt(hook, delivery)), 4)
            .onErrorResume(e -> {
                log.warn("Webhook delivery pass failed: {}", e.toString());
                return Mono.empty();
            })
            .subscribe();
    }

    /**
     * Retries everything due. Driven by the scheduled job rather than a timer per delivery,
     * so a backlog is processed in a bounded batch instead of thousands of pending timers.
     */
    public Mono<Integer> sweep() {
        Instant now = Instant.now();
        return webhooks.findDue(now, sweepBatch)
            .flatMap(delivery -> webhooks.findById(delivery.webhookId())
                .flatMap(hook -> attempt(hook, delivery))
                .thenReturn(1)
                .onErrorReturn(0), 4)
            .reduce(0, Integer::sum);
    }

    /**
     * One HTTP attempt, recording the outcome.
     *
     * <p>The status split is the whole retry policy: 2xx is done, and anything else is
     * retried until attempts run out. Notably a 4xx IS retried - a receiver answering 404 or
     * 401 is usually mid-deploy or mid-rotation rather than permanently wrong, and the
     * attempt ceiling already bounds the cost of being wrong about that.
     */
    private Mono<Void> attempt(Webhook hook, WebhookDelivery delivery) {
        Instant now = Instant.now();
        String signature = WebhookSigner.signatureHeader(hook.secret(), delivery.payload(), now);
        int attemptNumber = delivery.attempts() + 1;

        return webClient.post()
            .uri(hook.url())
            .header("Content-Type", "application/json")
            .header("User-Agent", "Switchboard-Webhooks/1")
            .header("X-Switchboard-Event", delivery.eventType().wireName())
            .header("X-Switchboard-Event-Id", delivery.eventId().toString())
            .header("X-Switchboard-Delivery-Id", delivery.id().toString())
            .header("X-Switchboard-Attempt", Integer.toString(attemptNumber))
            .header("X-Switchboard-Signature", signature)
            .bodyValue(delivery.payload())
            .exchangeToMono(response -> {
                HttpStatusCode status = response.statusCode();
                return response.releaseBody().then(status.is2xxSuccessful()
                    ? webhooks.markDelivered(delivery.id(), status.value(), Instant.now())
                    : recordFailure(delivery, attemptNumber, status.value(), "HTTP " + status.value()));
            })
            .timeout(timeout)
            .onErrorResume(e -> recordFailure(delivery, attemptNumber, null, e.toString()))
            .then();
    }

    private Mono<Void> recordFailure(WebhookDelivery delivery, int attemptNumber, Integer status, String error) {
        if (attemptNumber >= WebhookDelivery.MAX_ATTEMPTS) {
            log.warn("Webhook delivery {} exhausted after {} attempts: {}",
                delivery.id(), attemptNumber, error);
            return webhooks.markFailed(delivery.id(), status, error);
        }
        Instant next = Instant.now().plus(WebhookDelivery.backoff(attemptNumber));
        return webhooks.markRetry(delivery.id(), status, error, next);
    }

    private String serialise(WebhookEvent event) {
        try {
            return json.writeValueAsString(event.body());
        } catch (Exception e) {
            throw new IllegalStateException("Cannot serialise webhook payload", e);
        }
    }
}
