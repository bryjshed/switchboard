package com.switchboard.interfaces.security;

import java.util.UUID;

/**
 * Principal for management-surface requests.
 *
 * <p>Provider-neutral by construction: {@code issuer} is whatever verified this request - an OIDC
 * issuer URL, or {@code switchboard:dev} - and nothing downstream needs to know which vendor that
 * is. {@code userId} is the only thing the rest of the application authorises against; the
 * identity fields are here for auditing and for telling two identities of one user apart.
 *
 * <p>{@code verifiedEmail} is the email THIS request's credential vouched for: the token's email
 * when the identity provider asserted it verified, or when the credential is a local dev token;
 * otherwise null. It is not simply {@code email}, which is the stored user row's address and says
 * nothing about whether the current token proves ownership of it. Personal access tokens and SDK
 * keys never carry one - they prove possession of a secret, not of a mailbox. Its one consumer is
 * {@code GET /api/users/me}, which accepts pending invitations for a verified address.
 */
public record AuthenticatedUser(UUID userId, String email, String issuer, String subject, String verifiedEmail) {
}
