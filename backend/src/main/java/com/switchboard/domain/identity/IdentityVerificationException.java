package com.switchboard.domain.identity;

/**
 * A credential was presented and rejected: bad signature, wrong audience, expired, no email
 * claim, or no configured provider willing to speak for its issuer.
 *
 * <p>Plain Java on purpose. The security layer is what turns this into a 401; the domain does not
 * know that HTTP exists.
 */
public class IdentityVerificationException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public IdentityVerificationException(String message) {
        super(message);
    }

    public IdentityVerificationException(String message, Throwable cause) {
        super(message, cause);
    }
}
