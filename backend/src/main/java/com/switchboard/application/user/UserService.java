package com.switchboard.application.user;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.cache.SwitchboardCache;
import com.switchboard.domain.identity.Identities;
import com.switchboard.domain.identity.VerifiedIdentity;
import com.switchboard.domain.org.MembershipView;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserIdentity;
import com.switchboard.domain.user.UserRepository;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class UserService {

    private final UserRepository users;
    private final SwitchboardCache<String, User> identities;
    private final DatabaseClient db;

    public UserService(UserRepository users, DatabaseClient db, CacheRegistry caches) {
        this.users = users;
        this.db = db;
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
     * <p><b>The email-linking safety rule.</b> Matching on email is an account-takeover path if the
     * asserting provider lets a user pick an arbitrary, unproven email: sign up at some IdP as
     * ceo@victim.com and you would inherit the CEO's account. So linking by email happens only when
     * one of these holds:
     *
     * <ul>
     *   <li>the token asserts {@code emailVerified}; or
     *   <li>the candidate user holds <em>only</em> {@code switchboard:dev} identities, i.e. it is a
     *       placeholder a local dev token provisioned and nobody has ever really signed into; or
     *   <li>the incoming identity is itself a dev token, which is a local-profile-only capability
     *       and therefore already inside the trust boundary it would have to cross.
     * </ul>
     *
     * <p>The second clause is the old "a real login adopts the dev-provisioned row" behaviour,
     * generalised: adoption now <em>adds</em> the real identity beside the dev one rather than
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
    }

    private Mono<User> linkOrProvision(VerifiedIdentity identity) {
        return users.findByEmailPreferringReal(identity.email())
            .filterWhen(candidate -> mayLinkByEmail(identity, candidate))
            .switchIfEmpty(Mono.defer(() -> users.create(identity.email(), identity.displayName())))
            .flatMap(user -> link(user, identity));
    }

    private Mono<Boolean> mayLinkByEmail(VerifiedIdentity identity, User candidate) {
        if (identity.emailVerified() || Identities.DEV_ISSUER.equals(identity.issuer())) {
            return Mono.just(true);
        }
        return users.identitiesOf(candidate.id())
            .all(linked -> Identities.DEV_ISSUER.equals(linked.issuer()));
    }

    /**
     * Two first logins for the same identity can race; the unique index on
     * {@code (issuer, subject)} settles it and the loser reads the winner's row.
     */
    private Mono<User> link(User user, VerifiedIdentity identity) {
        return users.linkIdentity(user.id(), identity.issuer(), identity.subject())
            .thenReturn(user)
            .onErrorResume(DataIntegrityViolationException.class,
                e -> users.findByIssuerAndSubject(identity.issuer(), identity.subject()));
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
