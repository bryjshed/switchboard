package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.webhook.DeliveryStatus;
import com.switchboard.domain.webhook.Webhook;
import com.switchboard.domain.webhook.WebhookDelivery;
import com.switchboard.domain.webhook.WebhookEventType;
import com.switchboard.domain.webhook.WebhookRepository;
import io.r2dbc.postgresql.codec.Json;
import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** {@link WebhookRepository} over {@link DatabaseClient}. */
@Repository
public class WebhookRepositoryAdapter implements WebhookRepository {

    private static final String COLUMNS = """
        id, org_id, url, secret, description, event_types, project_id, environment_id,
        enabled, created_at, updated_at, created_by
        """;

    private final DatabaseClient db;

    public WebhookRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Mono<Webhook> create(Webhook webhook) {
        return db.sql("""
                INSERT INTO webhooks (id, org_id, url, secret, description, event_types,
                                      project_id, environment_id, enabled, created_by)
                VALUES (:id, :orgId, :url, :secret, :description, :eventTypes,
                        :projectId, :environmentId, :enabled, :createdBy)
                RETURNING
                """ + COLUMNS)
            .bind("id", webhook.id())
            .bind("orgId", webhook.orgId())
            .bind("url", webhook.url())
            .bind("secret", webhook.secret())
            .bind("description", webhook.description() == null ? "" : webhook.description())
            .bind("eventTypes", wireNames(webhook.eventTypes()))
            .bind("enabled", webhook.enabled())
            .bind("createdBy", webhook.createdBy() == null ? "" : webhook.createdBy())
            .bind("projectId", nullable(webhook.projectId()))
            .bind("environmentId", nullable(webhook.environmentId()))
            .map(WebhookRepositoryAdapter::mapWebhook)
            .one();
    }

    /**
     * Partial update: a null argument means "leave alone", which is what lets the PATCH-style
     * endpoint toggle {@code enabled} without a caller having to resend the filters.
     */
    @Override
    public Mono<Webhook> update(UUID id, String url, String description, List<WebhookEventType> eventTypes,
        UUID projectId, UUID environmentId, Boolean enabled) {
        return db.sql("""
                UPDATE webhooks SET
                    url = COALESCE(:url, url),
                    description = COALESCE(:description, description),
                    event_types = COALESCE(:eventTypes, event_types),
                    project_id = CASE WHEN :clearProject THEN NULL
                                      ELSE COALESCE(:projectId, project_id) END,
                    environment_id = CASE WHEN :clearEnvironment THEN NULL
                                          ELSE COALESCE(:environmentId, environment_id) END,
                    enabled = COALESCE(:enabled, enabled),
                    updated_at = now()
                WHERE id = :id
                RETURNING
                """ + COLUMNS)
            .bind("id", id)
            .bind("url", nullableText(url))
            .bind("description", nullableText(description))
            .bind("eventTypes", eventTypes == null
                ? Parameters.in(String[].class)
                : wireNames(eventTypes))
            .bind("projectId", nullable(projectId))
            .bind("environmentId", nullable(environmentId))
            .bind("clearProject", false)
            .bind("clearEnvironment", false)
            .bind("enabled", enabled == null ? Parameters.in(Boolean.class) : enabled)
            .map(WebhookRepositoryAdapter::mapWebhook)
            .one();
    }

    @Override
    public Mono<Void> delete(UUID id) {
        return db.sql("DELETE FROM webhooks WHERE id = :id").bind("id", id).then();
    }

    @Override
    public Mono<Webhook> findById(UUID id) {
        return db.sql("SELECT " + COLUMNS + " FROM webhooks WHERE id = :id")
            .bind("id", id)
            .map(WebhookRepositoryAdapter::mapWebhook)
            .one();
    }

    @Override
    public Flux<Webhook> listByOrg(UUID orgId) {
        return db.sql("SELECT " + COLUMNS + " FROM webhooks WHERE org_id = :orgId ORDER BY created_at DESC")
            .bind("orgId", orgId)
            .map(WebhookRepositoryAdapter::mapWebhook)
            .all();
    }

    @Override
    public Flux<Webhook> findEnabledForOrg(UUID orgId) {
        return db.sql("SELECT " + COLUMNS + " FROM webhooks WHERE org_id = :orgId AND enabled")
            .bind("orgId", orgId)
            .map(WebhookRepositoryAdapter::mapWebhook)
            .all();
    }

    @Override
    public Mono<Void> enqueue(List<WebhookDelivery> deliveries) {
        return Flux.fromIterable(deliveries)
            .concatMap(delivery -> db.sql("""
                    INSERT INTO webhook_deliveries
                        (id, webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at)
                    VALUES (:id, :webhookId, :eventId, :eventType, :payload, 'PENDING', 0, now())
                    """)
                .bind("id", delivery.id())
                .bind("webhookId", delivery.webhookId())
                .bind("eventId", delivery.eventId())
                .bind("eventType", delivery.eventType().wireName())
                .bind("payload", Json.of(delivery.payload()))
                .then())
            .then();
    }

    @Override
    public Flux<WebhookDelivery> findDue(Instant now, int limit) {
        return db.sql("""
                SELECT id, webhook_id, event_id, event_type, payload, status, attempts,
                       response_status, error, next_attempt_at, created_at, delivered_at
                FROM webhook_deliveries
                WHERE status = 'PENDING' AND next_attempt_at <= :now
                ORDER BY next_attempt_at
                LIMIT :limit
                """)
            .bind("now", now)
            .bind("limit", limit)
            .map(WebhookRepositoryAdapter::mapDelivery)
            .all();
    }

    @Override
    public Mono<Void> markDelivered(UUID deliveryId, int responseStatus, Instant when) {
        return db.sql("""
                UPDATE webhook_deliveries
                SET status = 'DELIVERED', attempts = attempts + 1, response_status = :status,
                    error = NULL, delivered_at = :when
                WHERE id = :id
                """)
            .bind("id", deliveryId)
            .bind("status", responseStatus)
            .bind("when", when)
            .then();
    }

    @Override
    public Mono<Void> markRetry(UUID deliveryId, Integer responseStatus, String error, Instant nextAttemptAt) {
        return db.sql("""
                UPDATE webhook_deliveries
                SET attempts = attempts + 1, response_status = :status, error = :error,
                    next_attempt_at = :next
                WHERE id = :id
                """)
            .bind("id", deliveryId)
            .bind("status", nullableInt(responseStatus))
            .bind("error", truncate(error))
            .bind("next", nextAttemptAt)
            .then();
    }

    @Override
    public Mono<Void> markFailed(UUID deliveryId, Integer responseStatus, String error) {
        return db.sql("""
                UPDATE webhook_deliveries
                SET status = 'FAILED', attempts = attempts + 1, response_status = :status, error = :error
                WHERE id = :id
                """)
            .bind("id", deliveryId)
            .bind("status", nullableInt(responseStatus))
            .bind("error", truncate(error))
            .then();
    }

    @Override
    public Flux<WebhookDelivery> listDeliveries(UUID webhookId, int limit) {
        return db.sql("""
                SELECT id, webhook_id, event_id, event_type, payload, status, attempts,
                       response_status, error, next_attempt_at, created_at, delivered_at
                FROM webhook_deliveries
                WHERE webhook_id = :webhookId
                ORDER BY created_at DESC
                LIMIT :limit
                """)
            .bind("webhookId", webhookId)
            .bind("limit", limit)
            .map(WebhookRepositoryAdapter::mapDelivery)
            .all();
    }

    // ---------------------------------------------------------------- mapping

    private static Webhook mapWebhook(Readable row) {
        String[] types = row.get("event_types", String[].class);
        List<WebhookEventType> parsed = new ArrayList<>();
        if (types != null) {
            for (String raw : types) {
                // Unknown names are dropped rather than fatal: a filter written by a newer
                // version must not stop an older instance reading the row at all.
                WebhookEventType type = WebhookEventType.fromWireName(raw);
                if (type != null) {
                    parsed.add(type);
                }
            }
        }
        return new Webhook(
            row.get("id", UUID.class),
            row.get("org_id", UUID.class),
            row.get("url", String.class),
            row.get("secret", String.class),
            row.get("description", String.class),
            List.copyOf(parsed),
            row.get("project_id", UUID.class),
            row.get("environment_id", UUID.class),
            Boolean.TRUE.equals(row.get("enabled", Boolean.class)),
            row.get("created_at", Instant.class),
            row.get("updated_at", Instant.class),
            row.get("created_by", String.class));
    }

    private static WebhookDelivery mapDelivery(Readable row) {
        Json payload = row.get("payload", Json.class);
        return new WebhookDelivery(
            row.get("id", UUID.class),
            row.get("webhook_id", UUID.class),
            row.get("event_id", UUID.class),
            WebhookEventType.fromWireName(row.get("event_type", String.class)),
            payload == null ? "{}" : payload.asString(),
            DeliveryStatus.valueOf(row.get("status", String.class)),
            row.get("attempts", Integer.class),
            row.get("response_status", Integer.class),
            row.get("error", String.class),
            row.get("next_attempt_at", Instant.class),
            row.get("created_at", Instant.class),
            row.get("delivered_at", Instant.class));
    }

    private static String[] wireNames(List<WebhookEventType> types) {
        return types.stream().map(WebhookEventType::wireName).toArray(String[]::new);
    }

    /**
     * A bound null still needs its TYPE, and the type has to be the column's.
     *
     * <p>Parameters.in(Class) rather than an R2dbcType constant: the first attempt bound
     * VARCHAR for a null uuid and Postgres rejected it outright with "column project_id is of
     * type uuid but expression is of type character varying". Deriving the type from the Java
     * class keeps the binding and the column in step by construction.
     */
    private static Object nullable(UUID value) {
        return value == null ? Parameters.in(UUID.class) : value;
    }

    private static Object nullableText(String value) {
        return value == null ? Parameters.in(String.class) : value;
    }

    private static Object nullableInt(Integer value) {
        return value == null ? Parameters.in(Integer.class) : value;
    }

    /** The column is unbounded but an error string is not worth storing a stack trace into. */
    private static String truncate(String error) {
        if (error == null) {
            return "";
        }
        return error.length() <= 500 ? error : error.substring(0, 500);
    }
}
