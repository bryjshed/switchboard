package com.switchboard.domain.webhook;

import java.util.Locale;

/**
 * What a webhook can be told about.
 *
 * <p>Wire names are dotted and lower-case ({@code flag.updated}) because that is what every
 * consumer of a webhook expects to route on, and they are the stable contract - the enum
 * constant is an implementation detail that may be renamed, the wire name may not.
 *
 * <p>The set is deliberately small. Every event here corresponds to a write that already
 * passes through {@code FlagTargetingService} or the rollout monitor, so none of them can be
 * emitted from a code path that bypassed audit.
 */
public enum WebhookEventType {

    /** A targeting configuration was written - the ordinary flag change. */
    FLAG_UPDATED("flag.updated"),

    /** A kill switch was engaged or released. Separate from an update because operators
     *  routinely want to page on this one alone. */
    FLAG_KILL_SWITCH("flag.kill_switch"),

    /** A configuration was rolled back. Note this writes a NEW version; history is never
     *  rewritten, so a rollback is an ordinary forward change with its own event. */
    FLAG_ROLLBACK("flag.rollback"),

    /** The rollout monitor raised a finding. This is what the pre-V8 notification hook sent,
     *  and the reason that setting could be migrated rather than dropped. */
    ROLLOUT_FINDING("rollout.finding");

    private final String wireName;

    WebhookEventType(String wireName) {
        this.wireName = wireName;
    }

    public String wireName() {
        return wireName;
    }

    /** Null for an unrecognised name rather than throwing: the value may come from a stored
     *  filter written by a newer version, and an unknown filter should match nothing. */
    public static WebhookEventType fromWireName(String raw) {
        if (raw == null) {
            return null;
        }
        String needle = raw.trim().toLowerCase(Locale.ROOT);
        for (WebhookEventType type : values()) {
            if (type.wireName.equals(needle)) {
                return type;
            }
        }
        return null;
    }
}
