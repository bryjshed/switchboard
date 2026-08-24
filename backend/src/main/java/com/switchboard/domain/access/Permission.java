package com.switchboard.domain.access;

/**
 * A capability the code checks by name. Permissions are CODE: adding one means a
 * release, because something has to enforce it. Roles - the named bundles that
 * grant permissions - are DATA, and live in the {@code roles} table.
 *
 * <p>Pure Java, no Spring, no persistence annotations: this enum is the
 * vocabulary shared by the resolver, the services, and the admin API.
 */
public enum Permission {

    /** Read flags, segments, versions, environments, and the org itself. Every built-in role has it. */
    FLAG_READ,

    /** Create, edit and archive flags; write targeting configuration. */
    FLAG_WRITE,

    /** Flip the kill switch. Separate from FLAG_WRITE because it is the emergency stop. */
    FLAG_KILL,

    /** Roll a flag-environment config back to an earlier version. */
    FLAG_ROLLBACK,

    /** Create, edit and delete segments. */
    SEGMENT_WRITE,

    /** Approve or decline a change request. */
    APPROVE_CHANGES,

    /** Add and remove org members, and grant or revoke role assignments. */
    MANAGE_MEMBERS,

    /** Mint and revoke SDK keys. */
    MANAGE_SDK_KEYS,

    /** Change org-wide settings (AI, auto-rollback, webhooks). */
    MANAGE_SETTINGS,

    /** Create a project in an org, and rename one. */
    MANAGE_PROJECTS,

    /** Create environments, and change an environment's approval policy. */
    MANAGE_ENVIRONMENTS,

    /** Read the audit log. */
    VIEW_AUDIT;

    /**
     * The enum constant of that name, or null when the running binary does not
     * know it. {@code role_permissions} deliberately carries no CHECK constraint,
     * so a row written by a newer release must be ignored rather than throw.
     */
    public static Permission parseOrNull(String name) {
        if (name == null) {
            return null;
        }
        try {
            return valueOf(name);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
