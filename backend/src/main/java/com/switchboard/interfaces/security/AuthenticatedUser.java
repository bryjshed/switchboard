package com.switchboard.interfaces.security;

import java.util.UUID;

/**
 * Principal for management-surface requests.
 *
 * <p>Provider-neutral by construction: {@code issuer} is whatever verified this request - an OIDC
 * issuer URL, or {@code switchboard:dev} - and nothing downstream needs to know which vendor that
 * is. {@code userId} is the only thing the rest of the application authorises against; the
 * identity fields are here for auditing and for telling two identities of one user apart.
 */
public record AuthenticatedUser(UUID userId, String email, String issuer, String subject) {
}
