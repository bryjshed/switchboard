package com.switchboard.application.user;

import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserRepository;
import reactor.core.publisher.Mono;

/**
 * Resolving "the user with this email" for an admin who is about to GRANT that user something.
 *
 * <p>An account existing for victim@corp.com proves nothing: Firebase email/password sign-up, and
 * any IdP that lets people type an address, creates one without checking the mailbox. Granting to
 * such an account hands access to whoever signed up first. So a grant by email resolves only to a
 * <em>verified</em> account (see {@link UserRepository#findVerifiedByEmail}).
 *
 * <p>When only unverified accounts exist the answer is 409 CONFLICT rather than 404 or 422: the
 * request is well-formed and the address is known, but the account is in a state that forbids
 * the operation until its owner verifies - the same shape as "already a member", which these
 * endpoints already answer with 409 and every client already handles. The message points at
 * invitations, which are the path that does work: a pending invitation is accepted as soon as a
 * verified token for the address signs in.
 */
public final class VerifiedAccounts {

    public static final String UNVERIFIED = "That account has not verified its email address, so it cannot be "
        + "granted access by email yet. Invite the address instead (POST /api/orgs/{orgId}/invitations): the "
        + "invitation is accepted as soon as its owner signs in with a verified email.";

    private VerifiedAccounts() {
    }

    /** The verified account for {@code email}; 409 when only unverified ones exist; 404 when none. */
    public static Mono<User> requireVerified(UserRepository users, String email, String notFoundMessage) {
        return users.findVerifiedByEmail(email)
            .switchIfEmpty(Mono.defer(() -> users.findByEmailPreferringReal(email)
                .flatMap(unverified -> Mono.<User>error(new ConflictException(UNVERIFIED)))))
            .switchIfEmpty(Mono.error(new NotFoundException(notFoundMessage)));
    }
}
