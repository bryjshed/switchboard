package com.switchboard.domain.identity;

/** Issuer names Switchboard mints itself, as opposed to ones an external IdP asserts. */
public final class Identities {

    /**
     * The issuer recorded for rows provisioned by the local {@code dev:<email>} token. It is not
     * a URL because nothing issues it over a network: it exists so a dev-provisioned account is
     * distinguishable from a real one, which is what makes adoption safe (see {@code UserService}).
     */
    public static final String DEV_ISSUER = "switchboard:dev";

    private Identities() {
    }
}
