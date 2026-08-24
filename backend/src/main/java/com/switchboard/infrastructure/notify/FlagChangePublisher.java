package com.switchboard.infrastructure.notify;

import com.switchboard.application.evaluation.EnvSnapshotCache;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * After-commit propagation of a flag/env change: evicts the local snapshot cache
 * immediately and fires pg_notify('flag_change', 'envId:flagKey:stateVersion')
 * fire-and-forget so every instance's PgNotifyListener evicts + streams. NOTIFY
 * errors are logged and swallowed - the write itself has already committed.
 */
@Component
public class FlagChangePublisher {

    public static final String CHANNEL = "flag_change";

    private static final Logger log = LoggerFactory.getLogger(FlagChangePublisher.class);

    private final DatabaseClient db;
    private final EnvSnapshotCache cache;

    public FlagChangePublisher(DatabaseClient db, EnvSnapshotCache cache) {
        this.db = db;
        this.cache = cache;
    }

    /** flagKey may be empty for changes without a single-flag scope (create/archive/segment edits). */
    public void publish(UUID environmentId, String flagKey, long stateVersion) {
        cache.invalidate(environmentId);
        String payload = environmentId + ":" + (flagKey == null ? "" : flagKey) + ":" + stateVersion;
        db.sql("SELECT pg_notify('" + CHANNEL + "', :payload)")
            .bind("payload", payload)
            .then()
            .doOnError(e -> log.warn("pg_notify({}) failed for [{}]: {}", CHANNEL, payload, e.getMessage()))
            .onErrorResume(e -> Mono.empty())
            .subscribe();
    }
}
