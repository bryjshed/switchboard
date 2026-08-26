package com.switchboard.domain.webhook;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Persistence port for webhooks and their delivery attempts. */
public interface WebhookRepository {

    Mono<Webhook> create(Webhook webhook);

    Mono<Webhook> update(UUID id, String url, String description, List<WebhookEventType> eventTypes,
        UUID projectId, UUID environmentId, Boolean enabled);

    Mono<Void> delete(UUID id);

    Mono<Webhook> findById(UUID id);

    Flux<Webhook> listByOrg(UUID orgId);

    /** Enabled hooks for one org. The read on the flag-write path, so it is kept narrow. */
    Flux<Webhook> findEnabledForOrg(UUID orgId);

    /** Inserts the outbox rows. Called INSIDE the caller's transaction. */
    Mono<Void> enqueue(List<WebhookDelivery> deliveries);

    /** Due, still-pending deliveries, oldest first. */
    Flux<WebhookDelivery> findDue(Instant now, int limit);

    Mono<Void> markDelivered(UUID deliveryId, int responseStatus, Instant when);

    Mono<Void> markRetry(UUID deliveryId, Integer responseStatus, String error, Instant nextAttemptAt);

    Mono<Void> markFailed(UUID deliveryId, Integer responseStatus, String error);

    Flux<WebhookDelivery> listDeliveries(UUID webhookId, int limit);
}
