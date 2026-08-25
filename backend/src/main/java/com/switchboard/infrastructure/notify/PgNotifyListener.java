package com.switchboard.infrastructure.notify;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.evaluation.EnvSnapshotCache;
import com.switchboard.application.stream.EnvironmentStreamHub;
import io.r2dbc.postgresql.PostgresqlConnectionConfiguration;
import io.r2dbc.postgresql.PostgresqlConnectionFactory;
import io.r2dbc.postgresql.api.Notification;
import io.r2dbc.postgresql.api.PostgresqlConnection;
import java.net.URI;
import java.time.Duration;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.util.retry.Retry;

/**
 * LISTENs on the {@value FlagChangePublisher#CHANNEL} channel over a dedicated
 * PostgresqlConnection (outside the R2DBC pool) and, per notification, evicts the
 * env snapshot cache and pushes the changed flag key to the stream hub.
 *
 * <p>Payload format: {@code envId:flagKey:stateVersion} (flagKey may be empty for
 * changes without a single-flag scope - those only evict). A 30s SELECT 1
 * keepalive is merged into the notification stream because the dedicated
 * connection sits outside the pool's keepalive; the whole pipeline retries with
 * backoff forever.
 */
@Component
public class PgNotifyListener implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(PgNotifyListener.class);

    private final EnvSnapshotCache cache;
    private final EnvironmentStreamHub hub;
    private final CacheRegistry caches;
    private final PostgresqlConnectionFactory connectionFactory;

    private volatile Disposable subscription;
    private volatile boolean running;

    public PgNotifyListener(
        EnvSnapshotCache cache,
        EnvironmentStreamHub hub,
        CacheRegistry caches,
        @Value("${spring.r2dbc.url}") String r2dbcUrl,
        @Value("${spring.r2dbc.username}") String username,
        @Value("${spring.r2dbc.password}") String password) {
        this.cache = cache;
        this.hub = hub;
        this.caches = caches;
        this.connectionFactory = new PostgresqlConnectionFactory(
            connectionConfig(r2dbcUrl, username, password));
    }

    /** Parses r2dbc:postgresql://host:port/db into a dedicated-connection configuration. */
    static PostgresqlConnectionConfiguration connectionConfig(String r2dbcUrl, String username, String password) {
        URI uri = URI.create(r2dbcUrl.replaceFirst("^r2dbc:", ""));
        String database = uri.getPath().replaceFirst("^/", "");
        return PostgresqlConnectionConfiguration.builder()
            .host(uri.getHost())
            .port(uri.getPort() == -1 ? 5432 : uri.getPort())
            .database(database)
            .username(username)
            .password(password)
            .build();
    }

    @Override
    public void start() {
        subscription = Flux.usingWhen(
                connectionFactory.create(),
                conn -> Flux.from(conn.createStatement("LISTEN " + FlagChangePublisher.CHANNEL).execute())
                    .thenMany(conn.createStatement("LISTEN " + CacheInvalidationPublisher.CHANNEL).execute())
                    .thenMany(notifications(conn))
                    .doOnNext(notification ->
                        dispatch(notification.getName(), notification.getParameter()))
                    .doOnError(e -> log.warn("flag_change listener error: {}", e.getMessage())),
                PostgresqlConnection::close)
            .retryWhen(Retry.backoff(Long.MAX_VALUE, Duration.ofSeconds(5))
                .maxBackoff(Duration.ofMinutes(2))
                .doBeforeRetry(signal -> log.info(
                    "Reconnecting flag_change listener (attempt {})", signal.totalRetries() + 1)))
            .subscribe(
                null,
                e -> {
                    running = false;
                    log.error("flag_change listener failed permanently", e);
                });
        running = true;
        log.info("flag_change listener started");
    }

    /**
     * Merges the notification stream with a 30s SELECT 1 keepalive: the dedicated
     * connection is otherwise idle between notifications and gets reset by
     * infrastructure idle timeouts.
     */
    private static Flux<Notification> notifications(PostgresqlConnection conn) {
        Flux<Notification> keepalive = Flux.interval(Duration.ofSeconds(30))
            .flatMap(tick -> Flux.from(conn.createStatement("SELECT 1").execute())
                .flatMap(result -> Flux.from(result.getRowsUpdated()).ignoreElements())
                .cast(Notification.class));
        return conn.getNotifications().mergeWith(keepalive);
    }

    /**
     * One connection carries both channels, so the channel name decides which handler runs.
     *
     * <p>A second dedicated connection would be tidier to read and would double the idle
     * connections a deployment holds open for what is, in both cases, an occasional message.
     */
    void dispatch(String channel, String payload) {
        if (CacheInvalidationPublisher.CHANNEL.equals(channel)) {
            onCacheInvalidation(payload);
        } else {
            onNotification(payload);
        }
    }

    /**
     * {@code CACHE_NAME:key}. An unknown cache name is dropped rather than thrown: during a rolling
     * deploy an older instance will legitimately receive names it has never heard of, and refusing
     * them noisily would turn a routine deploy into a wall of warnings.
     */
    void onCacheInvalidation(String payload) {
        int split = payload.indexOf(':');
        if (split < 1 || split == payload.length() - 1) {
            log.warn("{} listener: malformed payload [{}]", CacheInvalidationPublisher.CHANNEL, payload);
            return;
        }
        String name = payload.substring(0, split);
        String key = payload.substring(split + 1);
        try {
            CacheName cacheName = CacheName.valueOf(name);
            if (CacheInvalidationPublisher.WILDCARD.equals(key)) {
                caches.cache(cacheName).clear();
            } else {
                caches.cache(cacheName).evict(key);
            }
        } catch (IllegalArgumentException e) {
            log.debug("{} listener: unknown cache [{}], ignoring", CacheInvalidationPublisher.CHANNEL, name);
        }
    }

    /** Package-private for tests. Malformed payloads are logged and dropped. */
    void onNotification(String payload) {
        int first = payload.indexOf(':');
        int last = payload.lastIndexOf(':');
        if (first < 1 || last <= first) {
            log.warn("flag_change listener: malformed payload [{}]", payload);
            return;
        }
        UUID environmentId;
        try {
            environmentId = UUID.fromString(payload.substring(0, first));
        } catch (IllegalArgumentException e) {
            log.warn("flag_change listener: bad environment id in payload [{}]", payload);
            return;
        }
        String flagKey = payload.substring(first + 1, last);
        cache.invalidate(environmentId);
        if (!flagKey.isEmpty()) {
            hub.publish(environmentId, flagKey);
        }
    }

    @Override
    public void stop() {
        if (subscription != null && !subscription.isDisposed()) {
            subscription.dispose();
        }
        running = false;
        log.info("flag_change listener stopped");
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}
