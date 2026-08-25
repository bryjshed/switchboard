package com.switchboard.domain.identity;

/**
 * The result of authenticating a caller, expressed without reference to whoever authenticated
 * them. This is the whole vocabulary the application layer gets after the security filter chain
 * has done its work: no vendor SDK type, no JWT, no provider id.
 *
 * <p>{@code issuer} plus {@code subject} is the identity's primary key. Both come from the token
 * <em>after</em> verification - an issuer read off an unverified token selects a provider and
 * nothing more.
 *
 * @param issuer        the identity provider that vouched for this subject (an OIDC {@code iss},
 *                      or {@code switchboard:dev} for the local dev-token provider)
 * @param subject       the provider's stable identifier for the person (an OIDC {@code sub})
 * @param email         the email the provider asserts, never blank
 * @param displayName   a human-readable name, or {@code null} when the provider asserts none
 * @param emailVerified whether the provider asserts the email has been proven. Account linking
 *                      by email hangs off this flag - see {@code UserService}
 */
public record VerifiedIdentity(
    String issuer,
    String subject,
    String email,
    String displayName,
    boolean emailVerified) {

    public VerifiedIdentity {
        require(issuer, "issuer");
        require(subject, "subject");
        require(email, "email");
    }

    private static void require(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("A verified identity needs a " + field);
        }
    }
}
