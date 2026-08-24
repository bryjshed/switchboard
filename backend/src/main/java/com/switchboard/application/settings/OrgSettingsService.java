package com.switchboard.application.settings;

import com.switchboard.application.audit.AuditWriter;
import java.util.UUID;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/** Org-scoped settings stored under org.&lt;orgId&gt;.* keys in app_settings. */
@Service
public class OrgSettingsService {

    private static final String CATEGORY = "org";

    private final SettingsService settings;
    private final AuditWriter audit;

    public OrgSettingsService(SettingsService settings, AuditWriter audit) {
        this.settings = settings;
        this.audit = audit;
    }

    public Mono<OrgSettings> get(UUID orgId) {
        return Mono.zip(
                settings.get(aiEnabledKey(orgId)).defaultIfEmpty("true"),
                settings.get(autoRollbackKey(orgId)).defaultIfEmpty("false"),
                settings.get(autoOptimizeKey(orgId)).defaultIfEmpty("false"),
                settings.get(staleFlagWeeksKey(orgId)).defaultIfEmpty("4"),
                settings.get(webhookKey(orgId)).map(v -> !v.isBlank()).defaultIfEmpty(false))
            .map(t -> new OrgSettings(
                Boolean.parseBoolean(t.getT1()),
                Boolean.parseBoolean(t.getT2()),
                Boolean.parseBoolean(t.getT3()),
                Integer.parseInt(t.getT4()),
                t.getT5()));
    }

    /** Upserts only the provided (non-null) fields, then writes one SETTINGS_UPDATE audit row. */
    public Mono<OrgSettings> update(
        UUID orgId,
        Boolean aiEnabled,
        Boolean autoRollbackEnabled,
        Boolean autoOptimizeEnabled,
        Integer staleFlagWeeks,
        String notificationWebhookUrl,
        String actorEmail) {

        Mono<Void> writes = Mono.empty();
        if (aiEnabled != null) {
            writes = writes.then(upsert(aiEnabledKey(orgId), aiEnabled.toString(), actorEmail));
        }
        if (autoRollbackEnabled != null) {
            writes = writes.then(upsert(autoRollbackKey(orgId), autoRollbackEnabled.toString(), actorEmail));
        }
        if (autoOptimizeEnabled != null) {
            writes = writes.then(upsert(autoOptimizeKey(orgId), autoOptimizeEnabled.toString(), actorEmail));
        }
        if (staleFlagWeeks != null) {
            writes = writes.then(upsert(staleFlagWeeksKey(orgId), staleFlagWeeks.toString(), actorEmail));
        }
        if (notificationWebhookUrl != null) {
            writes = writes.then(upsert(webhookKey(orgId), notificationWebhookUrl, actorEmail));
        }
        return writes
            .then(audit.insert(orgId, null, null, null, "SETTINGS_UPDATE", actorEmail, null, null, null, null))
            .then(get(orgId));
    }

    private Mono<Void> upsert(String key, String value, String actorEmail) {
        return settings.upsert(key, value, false, CATEGORY, actorEmail);
    }

    private static String aiEnabledKey(UUID orgId) {
        return "org." + orgId + ".ai.enabled";
    }

    private static String autoRollbackKey(UUID orgId) {
        return "org." + orgId + ".autoRollback.enabled";
    }

    private static String autoOptimizeKey(UUID orgId) {
        return "org." + orgId + ".autoOptimize.enabled";
    }

    private static String staleFlagWeeksKey(UUID orgId) {
        return "org." + orgId + ".staleFlagWeeks";
    }

    private static String webhookKey(UUID orgId) {
        return "org." + orgId + ".notifications.webhook";
    }
}
