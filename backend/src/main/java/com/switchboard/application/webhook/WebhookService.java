package com.switchboard.application.webhook;

import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.webhook.Webhook;
import com.switchboard.domain.webhook.WebhookDelivery;
import com.switchboard.domain.webhook.WebhookEventType;
import com.switchboard.domain.webhook.WebhookRepository;
import com.switchboard.application.org.OrgAccessService;
import java.net.URI;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Webhook management. Guarded by {@link Permission#MANAGE_SETTINGS}, which is the permission
 * that already governs org-level configuration - a webhook is an org-level integration, not a
 * flag operation, and inventing a permission for it would add a second place for an
 * authorization bug to live.
 */
@Service
public class WebhookService {

    /** Long enough that guessing is not a strategy; hex so it survives copy-paste anywhere. */
    private static final int SECRET_BYTES = 32;
    private static final String SECRET_PREFIX = "whsec_";
    private static final int MAX_DELIVERIES = 50;

    private final WebhookRepository webhooks;
    private final OrgAccessService access;
    private final SecureRandom random = new SecureRandom();

    public WebhookService(WebhookRepository webhooks, OrgAccessService access) {
        this.webhooks = webhooks;
        this.access = access;
    }

    /**
     * Creates a webhook and returns it WITH its secret. This is the only time the secret is
     * ever readable - the same discipline as an SDK key or a PAT, except that here the server
     * must keep the plaintext too, because HMAC needs the key itself rather than a digest.
     */
    public Mono<Webhook> create(UUID orgId, UUID userId, String url, String description,
        List<String> eventTypes, UUID projectId, UUID environmentId) {
        return access.requireOrgPermission(orgId, userId, Permission.MANAGE_SETTINGS)
            .then(Mono.fromCallable(() -> {
                validateUrl(url);
                return new Webhook(
                    UUID.randomUUID(), orgId, url, generateSecret(), description,
                    parseTypes(eventTypes), projectId, environmentId, true, null, null,
                    userId == null ? null : userId.toString());
            }))
            .flatMap(webhooks::create);
    }

    public Flux<Webhook> list(UUID orgId, UUID userId) {
        return access.requireOrgPermission(orgId, userId, Permission.MANAGE_SETTINGS)
            .thenMany(webhooks.listByOrg(orgId))
            .map(Webhook::withoutSecret);
    }

    public Mono<Webhook> update(UUID webhookId, UUID userId, String url, String description,
        List<String> eventTypes, UUID projectId, UUID environmentId, Boolean enabled) {
        return owned(webhookId, userId)
            .flatMap(existing -> {
                if (url != null) {
                    validateUrl(url);
                }
                return webhooks.update(webhookId, url, description,
                    eventTypes == null ? null : parseTypes(eventTypes),
                    projectId, environmentId, enabled);
            })
            .map(Webhook::withoutSecret);
    }

    public Mono<Void> delete(UUID webhookId, UUID userId) {
        return owned(webhookId, userId).flatMap(hook -> webhooks.delete(hook.id()));
    }

    /** Recent delivery attempts - the answer to "did my endpoint actually get it". */
    public Flux<WebhookDelivery> deliveries(UUID webhookId, UUID userId, int limit) {
        return owned(webhookId, userId)
            .flatMapMany(hook -> webhooks.listDeliveries(
                hook.id(), limit <= 0 || limit > MAX_DELIVERIES ? MAX_DELIVERIES : limit));
    }

    /** Resolves the webhook and checks the caller's standing in ITS org, not a supplied one. */
    private Mono<Webhook> owned(UUID webhookId, UUID userId) {
        return webhooks.findById(webhookId)
            .switchIfEmpty(Mono.error(new NotFoundException("Webhook not found")))
            .flatMap(hook -> access.requireOrgPermission(hook.orgId(), userId, Permission.MANAGE_SETTINGS)
                .thenReturn(hook));
    }

    private String generateSecret() {
        byte[] bytes = new byte[SECRET_BYTES];
        random.nextBytes(bytes);
        return SECRET_PREFIX + HexFormat.of().formatHex(bytes);
    }

    private static List<WebhookEventType> parseTypes(List<String> raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        List<WebhookEventType> parsed = new ArrayList<>();
        for (String name : raw) {
            WebhookEventType type = WebhookEventType.fromWireName(name);
            if (type == null) {
                throw new ValidationException("Unknown webhook event type: " + name);
            }
            parsed.add(type);
        }
        return List.copyOf(parsed);
    }

    /**
     * Rejects anything that is not an absolute http(s) URL.
     *
     * <p>This is validation, NOT an SSRF control, and the distinction matters because it
     * would be easy to mistake one for the other. A webhook URL is supposed to point at a
     * host the customer chose; blocking private address ranges here would break every
     * self-hosted deployment whose receiver is on the same network, which is most of them.
     * A deployment that needs egress restrictions should impose them at the network layer,
     * where they can actually be enforced - a DNS name resolving to a private address after
     * this check would pass it anyway.
     */
    private static void validateUrl(String url) {
        if (url == null || url.isBlank()) {
            throw new ValidationException("Webhook url is required");
        }
        URI uri;
        try {
            uri = URI.create(url.trim());
        } catch (IllegalArgumentException e) {
            throw new ValidationException("Webhook url is not a valid URI");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            throw new ValidationException("Webhook url must be http or https");
        }
        if (uri.getHost() == null) {
            throw new ValidationException("Webhook url must include a host");
        }
    }
}
