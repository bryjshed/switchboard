package com.switchboard.application.settings;

/** Resolved org-scoped settings with defaults applied. */
public record OrgSettings(
    boolean aiEnabled,
    boolean autoRollbackEnabled,
    boolean autoOptimizeEnabled,
    int staleFlagWeeks,
    boolean notificationWebhookSet) {
}
