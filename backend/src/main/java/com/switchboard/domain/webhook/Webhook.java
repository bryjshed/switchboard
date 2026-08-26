package com.switchboard.domain.webhook;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * A subscription to changes in one org, optionally narrowed to a project or environment.
 *
 * @param eventTypes empty means every type - see {@link #matches}
 * @param projectId  null means every project in the org
 * @param environmentId null means every environment
 */
public record Webhook(
    UUID id,
    UUID orgId,
    String url,
    String secret,
    String description,
    List<WebhookEventType> eventTypes,
    UUID projectId,
    UUID environmentId,
    boolean enabled,
    Instant createdAt,
    Instant updatedAt,
    String createdBy) {

    public Webhook {
        eventTypes = eventTypes == null ? List.of() : List.copyOf(eventTypes);
    }

    /**
     * Whether this subscription wants a given event.
     *
     * <p>An EMPTY type list means "everything", not "nothing". That is the more useful default
     * for a hook someone just created, and the opposite reading would make a newly created
     * webhook silently deliver nothing at all - which reads as a broken integration rather
     * than as a filter that was never set.
     *
     * <p>Resource filters narrow rather than widen: a webhook scoped to a project sees only
     * that project, and one scoped to an environment only that environment. A null on either
     * is "no opinion", so an event carrying no project (an org-level finding) still matches a
     * project-scoped hook only when the hook has no project filter.
     */
    public boolean matches(WebhookEventType type, UUID eventProjectId, UUID eventEnvironmentId) {
        if (!enabled) {
            return false;
        }
        if (!eventTypes.isEmpty() && !eventTypes.contains(type)) {
            return false;
        }
        if (projectId != null && !projectId.equals(eventProjectId)) {
            return false;
        }
        return environmentId == null || environmentId.equals(eventEnvironmentId);
    }

    /** The same record with the secret blanked, for anything that leaves the server. */
    public Webhook withoutSecret() {
        return new Webhook(id, orgId, url, null, description, eventTypes, projectId, environmentId,
            enabled, createdAt, updatedAt, createdBy);
    }
}
