package com.switchboard.domain.project;

/**
 * What kind of holder an SDK key is for, and therefore how much it is allowed to see.
 *
 * <p>The distinction that matters is <b>secret versus public</b>. A {@link #SERVER} key lives in an
 * environment variable and is never handed to anyone; it can safely receive the full rule set and
 * evaluate locally. A {@link #CLIENT} or {@link #MOBILE} key ships inside something a user can read,
 * so anything it receives is effectively published.
 *
 * <p><b>The prefix is a hint, never the authority.</b> It is attacker-supplied text: a token spelled
 * {@code sb_srv_} whose row says {@code CLIENT} must be treated as CLIENT. The kind always comes
 * from the database row.
 */
public enum SdkKeyKind {

    /** Secret, server-side. Full rule set, local evaluation, every flag. */
    SERVER("sb_srv_"),

    /** Public, in a browser. Evaluated payloads only, and only client-available flags. */
    CLIENT("sb_cli_"),

    /**
     * Public, compiled into a mobile binary. Same reduced surface as {@link #CLIENT}.
     *
     * <p>Reserved rather than mintable today - there is no mobile SDK to hold one. It exists as a
     * separate kind because of rotation latency, not capability: revoking a browser key costs a
     * page refresh, while revoking a key baked into a shipped binary locks out every installed
     * version until users update. That difference belongs in the revoke dialog's wording and in
     * the audit trail.
     */
    MOBILE("sb_mob_");

    /** Every kind's prefix starts with this, which is what the auth filter routes on. */
    public static final String COMMON_PREFIX = "sb_";

    private final String prefix;

    SdkKeyKind(String prefix) {
        this.prefix = prefix;
    }

    public String prefix() {
        return prefix;
    }

    /** True when a key of this kind is readable by whoever runs the application holding it. */
    public boolean isPublic() {
        return this != SERVER;
    }

    /** Whether this kind may be minted through the API. */
    public boolean isMintable() {
        return this != MOBILE;
    }
}
