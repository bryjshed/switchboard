package com.switchboard.interfaces.rest;

import com.switchboard.application.webhook.WebhookService;
import com.switchboard.domain.webhook.Webhook;
import com.switchboard.domain.webhook.WebhookDelivery;
import com.switchboard.interfaces.rest.api.WebhooksApi;
import com.switchboard.interfaces.rest.model.WebhookCreateRequest;
import com.switchboard.interfaces.rest.model.WebhookCreatedResponse;
import com.switchboard.interfaces.rest.model.WebhookDeliveryResponse;
import com.switchboard.interfaces.rest.model.WebhookDeliveryStatus;
import com.switchboard.interfaces.rest.model.WebhookEventType;
import com.switchboard.interfaces.rest.model.WebhookResponse;
import com.switchboard.interfaces.rest.model.WebhookUpdateRequest;
import com.switchboard.interfaces.security.Principals;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Signed outbound webhooks. Thin over {@link WebhookService}, with static mappers. */
@RestController
public class WebhooksController implements WebhooksApi {

    private final WebhookService webhooks;

    public WebhooksController(WebhookService webhooks) {
        this.webhooks = webhooks;
    }

    @Override
    public Mono<ResponseEntity<WebhookCreatedResponse>> createWebhook(
        UUID orgId, Mono<WebhookCreateRequest> request, ServerWebExchange exchange) {

        return Principals.currentUser()
            .zipWith(request)
            .flatMap(t -> webhooks.create(orgId, t.getT1().userId(),
                t.getT2().getUrl(),
                t.getT2().getDescription(),
                wireNames(t.getT2().getEventTypes()),
                t.getT2().getProjectId(),
                t.getT2().getEnvironmentId()))
            .map(created -> ResponseEntity.status(HttpStatus.CREATED)
                .body(toCreatedResponse(created)));
    }

    @Override
    public Mono<ResponseEntity<Flux<WebhookResponse>>> listWebhooks(UUID orgId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(webhooks.list(orgId, user.userId()).map(WebhooksController::toResponse)));
    }

    @Override
    public Mono<ResponseEntity<WebhookResponse>> updateWebhook(
        UUID webhookId, Mono<WebhookUpdateRequest> request, ServerWebExchange exchange) {

        return Principals.currentUser()
            .zipWith(request)
            .flatMap(t -> webhooks.update(webhookId, t.getT1().userId(),
                t.getT2().getUrl(),
                t.getT2().getDescription(),
                wireNames(t.getT2().getEventTypes()),
                t.getT2().getProjectId(),
                t.getT2().getEnvironmentId(),
                t.getT2().getEnabled()))
            .map(updated -> ResponseEntity.ok(toResponse(updated)));
    }

    @Override
    public Mono<ResponseEntity<Void>> deleteWebhook(UUID webhookId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> webhooks.delete(webhookId, user.userId()))
            .thenReturn(ResponseEntity.noContent().build());
    }

    @Override
    public Mono<ResponseEntity<Flux<WebhookDeliveryResponse>>> listWebhookDeliveries(
        UUID webhookId, Integer limit, ServerWebExchange exchange) {

        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(
                webhooks.deliveries(webhookId, user.userId(), limit == null ? 50 : limit)
                    .map(WebhooksController::toDeliveryResponse)));
    }

    // ---------------------------------------------------------------- mapping

    /** Null stays null: the service reads it as "no filter change", not "clear the filter". */
    private static List<String> wireNames(List<WebhookEventType> types) {
        return types == null ? null : types.stream().map(WebhookEventType::getValue).toList();
    }

    private static WebhookResponse toResponse(Webhook hook) {
        return new WebhookResponse(
            hook.id(), hook.orgId(), hook.url(),
            hook.eventTypes().stream()
                .map(type -> WebhookEventType.fromValue(type.wireName()))
                .toList(),
            hook.enabled(),
            hook.createdAt())
            .description(hook.description())
            .projectId(hook.projectId())
            .environmentId(hook.environmentId())
            .updatedAt(hook.updatedAt());
    }

    private static WebhookCreatedResponse toCreatedResponse(Webhook hook) {
        return new WebhookCreatedResponse(
            hook.id(), hook.orgId(), hook.url(),
            hook.eventTypes().stream()
                .map(type -> WebhookEventType.fromValue(type.wireName()))
                .toList(),
            hook.enabled(),
            hook.createdAt(),
            // The one and only time the signing secret leaves the server.
            hook.secret())
            .description(hook.description())
            .projectId(hook.projectId())
            .environmentId(hook.environmentId())
            .updatedAt(hook.updatedAt());
    }

    private static WebhookDeliveryResponse toDeliveryResponse(WebhookDelivery delivery) {
        return new WebhookDeliveryResponse(
            delivery.id(), delivery.webhookId(), delivery.eventId(),
            WebhookEventType.fromValue(delivery.eventType().wireName()),
            WebhookDeliveryStatus.fromValue(delivery.status().name()),
            delivery.attempts(),
            delivery.createdAt())
            .responseStatus(delivery.responseStatus())
            .error(delivery.error())
            .nextAttemptAt(delivery.nextAttemptAt())
            .deliveredAt(delivery.deliveredAt());
    }
}
