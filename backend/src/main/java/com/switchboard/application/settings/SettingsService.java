package com.switchboard.application.settings;

import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * Runtime settings backed by app_settings. Values are stored plaintext for now
 * (encrypted=false); a cipher may be added later, the boolean column stays honest.
 */
@Service
public class SettingsService {

    private final DatabaseClient db;

    public SettingsService(DatabaseClient db) {
        this.db = db;
    }

    /** Empty when the key is absent. */
    public Mono<String> get(String key) {
        return db.sql("SELECT value FROM app_settings WHERE key = :key")
            .bind("key", key)
            .map(row -> row.get("value", String.class))
            .one();
    }

    /**
     * Upserts the setting and writes the app_settings_audit row atomically
     * (single CTE statement, so one transaction).
     */
    public Mono<Void> upsert(String key, String value, boolean encrypted, String category, String performedBy) {
        return db.sql("""
                WITH up AS (
                    INSERT INTO app_settings (key, value, encrypted, category, updated_by)
                    VALUES (:key, :value, :encrypted, :category, :performedBy)
                    ON CONFLICT (key) DO UPDATE SET
                        value = EXCLUDED.value,
                        encrypted = EXCLUDED.encrypted,
                        category = EXCLUDED.category,
                        updated_at = now(),
                        updated_by = EXCLUDED.updated_by
                    RETURNING (xmax = 0) AS inserted
                )
                INSERT INTO app_settings_audit (key, action, performed_by)
                SELECT :key, CASE WHEN up.inserted THEN 'CREATE' ELSE 'UPDATE' END, :performedBy
                FROM up
                """)
            .bind("key", key)
            .bind("value", value)
            .bind("encrypted", encrypted)
            .bind("category", category)
            .bind("performedBy", performedBy)
            .then();
    }
}
