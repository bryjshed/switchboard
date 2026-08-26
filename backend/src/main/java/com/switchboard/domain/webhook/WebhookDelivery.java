package com.switchboard.domain.webhook;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/**
 * One attempt chain: a single event aimed at a single webhook, with its retry state.
 *
 * <p>Rows are written in the same transaction as the change that produced them - a
 * transactional outbox - so an event cannot be lost by the process dying between the commit
 * and the enqueue. Delivery itself happens after commit.
 */
public record WebhookDelivery(
    UUID id,
    UUID webhookId,
    UUID eventId,
    WebhookEventType eventType,
    String payload,
    DeliveryStatus status,
    int attempts,
    Integer responseStatus,
    String error,
    Instant nextAttemptAt,
    Instant createdAt,
    Instant deliveredAt) {

    /**
     * Attempts before a delivery is abandoned. Six attempts over the backoff below spans a
     * little over an hour, which covers an ordinary receiver deploy or restart without
     * retrying into next week.
     */
    public static final int MAX_ATTEMPTS = 6;

    /**
     * Exponential backoff: 30s, 1m, 2m, 4m, 8m, 16m.
     *
     * <p>Deliberately NOT jittered, unlike the SDK's reconnect backoff. Jitter there stops a
     * fleet of clients reconnecting in lockstep; here the sweep already processes a batch
     * serially, and a predictable schedule is worth more because it is what an operator
     * reads off a delivery row when asking "when will this be tried again".
     */
    public static Duration backoff(int attempts) {
        int capped = Math.max(0, Math.min(attempts, MAX_ATTEMPTS));
        return Duration.ofSeconds(30L << capped);
    }

    public boolean exhausted() {
        return attempts >= MAX_ATTEMPTS;
    }
}
