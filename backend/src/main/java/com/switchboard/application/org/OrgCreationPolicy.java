package com.switchboard.application.org;

import java.util.Locale;

/**
 * Who may create an org on this instance: {@code switchboard.org-creation}
 * (env {@code SWITCHBOARD_ORG_CREATION}).
 *
 * <ul>
 *   <li>{@link #OPEN} - any authenticated user. The right answer for a hosted, multi-tenant
 *       instance, and the default, because it is what every release before this one did.
 *   <li>{@link #BOOTSTRAP} - only while no org exists. The first person to sign in to a fresh
 *       self-hosted instance creates the company's org; everyone after that joins by invitation.
 *       Without it, every employee who signs in before being invited can create a stray org of
 *       their own.
 * </ul>
 */
public enum OrgCreationPolicy {
    OPEN,
    BOOTSTRAP;

    /** Case-insensitive; blank means {@link #OPEN}. Anything else refuses to start the app. */
    public static OrgCreationPolicy parse(String value) {
        if (value == null || value.isBlank()) {
            return OPEN;
        }
        try {
            return valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(
                "switchboard.org-creation must be 'open' or 'bootstrap', not '" + value + "'", e);
        }
    }
}
