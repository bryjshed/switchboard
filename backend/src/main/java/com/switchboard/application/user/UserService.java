package com.switchboard.application.user;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.cache.SwitchboardCache;
import com.switchboard.application.org.InvitationService;
import com.switchboard.domain.identity.Identities;
import com.switchboard.domain.identity.VerifiedIdentity;
import com.switchboard.domain.org.MembershipView;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserIdentity;
import com.switchboard.domain.user.UserRepository;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class UserService {

    private static final Logger log = LoggerFactory.getLogger(UserService.class);

    private final UserRepository users;
    private final SwitchboardCache<String, User> identities;
    private final DatabaseClient db;
    private final InvitationService invitations;

    public UserService(
        UserRepository users, DatabaseClient db, CacheRegistry caches, InvitationService invitations) {
        this.users = users;
        this.db = db;
        this.invitations = invitations;
        this.identities = caches.cache(CacheName.USER_IDENTITY);
    }

    /**
     * Resolves the user behind a verified identity, whoever verified it.
     *
     * <p>Three outcomes, in order:
     *
     * <ol>
     *   <li><b>Known identity.</b> {@code (issuer, subject)} has been seen before - return its user.
     *   <li><b>Link to an existing user by email.</b> This is how a person keeps their account when
     *       their org moves from one IdP to another: the Okta token is a new identity, and it
     *       attaches to the user the Firebase token created. Gated - see below.
     *   <li><b>Auto-provision.</b> A new user, plus this identity linked to it.
     * </ol>
     *
     * <p><b>The email-linking safety rule.</b> Matching on email is an account-takeover path in
     * both directions, so linking by email happens only when it is safe for BOTH sides:
     *
     * <ul>
     *   <li><b>The incoming identity must prove the address</b> - its token asserts
     *       {@code emailVerified} - or else the candidate must be a pure dev placeholder (it holds
     *       at least one identity and every one is {@code switchboard:dev}, i.e. nobody has ever
     *       really signed into it). Otherwise signing up at some IdP as ceo@victim.com would
     *       inherit the CEO's account.
     *   <li><b>The candidate must not already hold an unproven real identity</b> - one from a
     *       real provider whose {@code email_verified} is still false. Otherwise it is the
     *       pre-registration attack: the attacker signs up unverified as victim@corp.com first,
     *       the victim later arrives with a verified token, is merged INTO the attacker's
     *       account - and everything the victim is then granted, the attacker's password also
     *       opens. The victim gets a fresh account instead.
     *   <li>A dev token links regardless: it is a local-profile-only capability and therefore
     *       already inside the trust boundary it would have to cross.
     * </ul>
     *
     * <p>An account SCIM created has no identities at all, so a verified token adopts it and an
     * unverified one does not.
     *
     * <p>The placeholder clause is the old "a real login adopts the dev-provisioned row" behaviour,
     * generalised: adoption <em>adds</em> the real identity beside the dev one rather than
     * re-keying a column, so the same person stays one user id whichever token they arrive with.
     *
     * <p>When the rule refuses, the login still succeeds - as a separate, new user. Two rows may
     * then share an email, which is why {@code users.email} is indexed but not unique.
     */
    /** The user behind an id, for credentials that already know who they belong to. */
    public Mono<User> findById(java.util.UUID userId) {
        return users.findById(userId);
    }

    public Mono<User> resolveIdentity(VerifiedIdentity identity) {
        return identities.get(
            identity.issuer() + "\u0000" + identity.subject(),
            key -> users.findByIssuerAndSubject(identity.issuer(), identity.subject()))
            // Provisioning is deliberately OUTSIDE the cache: it writes, and a write must not sit
            // behind a read-through. The cache only ever holds an identity that already resolved,
            // so the very next request after a provision is a miss that finds the new row.
            .switchIfEmpty(Mono.defer(() -> linkOrProvision(identity)));
        // Deliberately does NOT refuse a deactivated user. This method resolves an identity to a
        // person; whether that person may currently do anything is an authorization question,
        // and answering it here made a deactivated account surface as a 500 - the exception was
        // thrown inside the authentication manager, where the security chain has no error
        // mapping for it. SwitchboardAuthenticationManager makes that decision instead.
    }

    private Mono<User> linkOrProvision(VerifiedIdentity identity) {
        return linkCandidate(identity)
            .filterWhen(candidate -> mayLinkByEmail(identity, candidate))
            .switchIfEmpty(Mono.defer(() -> users.create(identity.email(), identity.displayName())))
            .flatMap(user -> link(user, identity))
            .flatMap(user -> acceptInvitations(identity, user));
    }

    /**
     * Pending org invitations are accepted in two places, and only ever for an email the provider
     * vouched for - the same rule, for the same reason, as linking by email: an IdP that lets
     * anyone claim bob@corp.com must not hand them bob's invitation. Dev tokens count as vouched
     * for because they only exist on the local profile.
     *
     * <ol>
     *   <li><b>Here, on an identity's first sign-in</b>, so a verified invitee is a member before
     *       the very request that created them is authorized.
     *   <li><b>{@link #onVerifiedSession} from {@code GET /api/users/me}</b>, on every
     *       call. This is the path for a person whose first sign-in was NOT verified - Firebase
     *       email/password users always start that way - and who verifies later: the dashboard
     *       refreshes the token and calls /users/me, and the now-verified token accepts. It is
     *       kept off the general authentication path deliberately; only /users/me pays for it,
     *       and what it pays is one probe of a partial index that is empty for almost everyone.
     * </ol>
     *
     * <p>Never fails the sign-in: an invitation that cannot be accepted is logged and the person
     * gets in without it, which is recoverable, where a 500 at login is not.
     */
    private Mono<User> acceptInvitations(VerifiedIdentity identity, User user) {
        if (!identity.emailVerified() && !Identities.DEV_ISSUER.equals(identity.issuer())) {
            return Mono.just(user);
        }
        return invitations.acceptPendingFor(user, identity.email())
            .then()
            .onErrorResume(e -> {
                log.warn("Accepting invitations for user {} failed: {}", user.id(), e.toString());
                return Mono.empty();
            })
            .thenReturn(user);
    }

    /**
     * Which existing account a new identity might join. A token that vouches for its email looks
     * for a VERIFIED account first (a proven identity, or one SCIM created): when an unverified
     * sign-up and a SCIM-provisioned account share the address, the employee's verified token
     * must land in the SCIM account, not beside the squatter's. Otherwise, and for unverified
     * tokens, the old preference applies. {@link #mayLinkByEmail} still has the final say.
     */
    private Mono<User> linkCandidate(VerifiedIdentity identity) {
        boolean vouched = identity.emailVerified() || Identities.DEV_ISSUER.equals(identity.issuer());
        return vouched
            ? users.findVerifiedByEmail(identity.email())
                .switchIfEmpty(Mono.defer(() -> users.findByEmailPreferringReal(identity.email())))
            : users.findByEmailPreferringReal(identity.email());
    }

    private Mono<Boolean> mayLinkByEmail(VerifiedIdentity identity, User candidate) {
        if (Identities.DEV_ISSUER.equals(identity.issuer())) {
            return Mono.just(true);
        }
        return users.identitiesOf(candidate.id()).collectList().map(linked -> {
            boolean holdsUnprovenRealIdentity = linked.stream()
                .anyMatch(i -> !Identities.DEV_ISSUER.equals(i.issuer()) && !i.emailVerified());
            if (holdsUnprovenRealIdentity) {
                return false;
            }
            if (identity.emailVerified()) {
                return true;
            }
            return !linked.isEmpty()
                && linked.stream().allMatch(i -> Identities.DEV_ISSUER.equals(i.issuer()));
        });
    }

    /**
     * Two first logins for the same identity can race; the unique index on
     * {@code (issuer, subject)} settles it and the loser reads the winner's row.
     */
    private Mono<User> link(User user, VerifiedIdentity identity) {
        // The candidate was found by (or created with) exactly identity.email(), so "this token
        // vouched for its email" is the same statement as "it vouched for this account's email".
        boolean vouched = identity.emailVerified() || Identities.DEV_ISSUER.equals(identity.issuer());
        return users.linkIdentity(user.id(), identity.issuer(), identity.subject(), vouched)
            .thenReturn(user)
            .onErrorResume(DataIntegrityViolationException.class,
                e -> users.findByIssuerAndSubject(identity.issuer(), identity.subject()));
    }

    /**
     * What {@code GET /api/users/me} does for a session whose token vouched for an email
     * ({@code verifiedEmail} non-null; never for a personal access token). Two things, in order:
     *
     * <ol>
     *   <li><b>Upgrade the identity's {@code email_verified}</b> when the vouched-for address is
     *       the account's own. This is how an account that signed up unverified becomes one an
     *       admin can add directly: the resolve cache means a returning identity never passes the
     *       link path again, so this is the only place a later verification can be recorded.
     *       Upgrade only - an unverified token never clears it.
     *   <li><b>Accept pending invitations</b> for the vouched-for address.
     * </ol>
     *
     * <p>Errors are logged and swallowed, like the sign-in path.
     */
    public Mono<Void> onVerifiedSession(
        UUID userId, String accountEmail, String issuer, String subject, String verifiedEmail) {
        if (verifiedEmail == null) {
            return Mono.empty();
        }
        Mono<Void> upgrade = verifiedEmail.equalsIgnoreCase(accountEmail)
            ? users.markEmailVerified(issuer, subject)
            : Mono.empty();
        return upgrade
            .then(invitations.acceptPendingForSession(userId, verifiedEmail).then())
            .onErrorResume(e -> {
                log.warn("Post-verification work for user {} failed: {}", userId, e.toString());
                return Mono.empty();
            });
    }

    /** The provider identities linked to one user, oldest first. */
    public Flux<UserIdentity> identitiesOf(UUID userId) {
        return users.identitiesOf(userId);
    }

    public Flux<MembershipView> membershipsOf(UUID userId) {
        return db.sql("""
                SELECT o.id AS org_id, o.name AS org_name, o.slug AS org_slug, m.role
                FROM org_memberships m JOIN orgs o ON o.id = m.org_id
                WHERE m.user_id = :userId
                ORDER BY o.name
                """)
            .bind("userId", userId)
            .map(row -> new MembershipView(
                row.get("org_id", UUID.class),
                row.get("org_name", String.class),
                row.get("org_slug", String.class),
                row.get("role", String.class)))
            .all();
    }
}
