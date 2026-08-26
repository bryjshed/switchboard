package com.switchboard.application.webhook;

import com.switchboard.domain.webhook.WebhookEventType;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * One thing that happened, before it is fanned out to whichever webhooks want it.
 *
 * <p>The payload shape is the public contract, so it is assembled in one place rather than at
 * each call site. Fields are flat and named the way the REST API names them, because a
 * webhook consumer is usually the same person who reads the API docs.
 *
 * @param projectId   null for an org-scoped event; used for resource filtering
 * @param environmentId null for an event with no single environment
 */
public record WebhookEvent(
    UUID eventId,
    WebhookEventType type,
    UUID orgId,
    UUID projectId,
    UUID environmentId,
    String projectKey,
    String envKey,
    String flagKey,
    Integer version,
    String actor,
    String summary,
    Instant occurredAt) {

    public static WebhookEvent of(WebhookEventType type, UUID orgId, UUID projectId, UUID environmentId,
        String projectKey, String envKey, String flagKey, Integer version, String actor, String summary) {
        return new WebhookEvent(UUID.randomUUID(), type, orgId, projectId, environmentId,
            projectKey, envKey, flagKey, version, actor, summary, Instant.now());
    }

    /**
     * The JSON body a receiver sees.
     *
     * <p>{@code id} is the EVENT id, shared by every delivery fanned out from this change and
     * stable across retries. That is what makes a receiver able to dedupe - retries are
     * at-least-once by construction, so a consumer that cannot dedupe will eventually act
     * twice on one change.
     */
    public Map<String, Object> body() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", eventId.toString());
        out.put("type", type.wireName());
        out.put("occurredAt", occurredAt.toString());
        Map<String, Object> data = new LinkedHashMap<>();
        putIfPresent(data, "orgId", orgId);
        putIfPresent(data, "projectId", projectId);
        putIfPresent(data, "projectKey", projectKey);
        putIfPresent(data, "environmentId", environmentId);
        putIfPresent(data, "envKey", envKey);
        putIfPresent(data, "flagKey", flagKey);
        putIfPresent(data, "version", version);
        putIfPresent(data, "actor", actor);
        putIfPresent(data, "summary", summary);
        out.put("data", data);
        return out;
    }

    private static void putIfPresent(Map<String, Object> map, String key, Object value) {
        if (value != null) {
            map.put(key, value instanceof UUID id ? id.toString() : value);
        }
    }
}
