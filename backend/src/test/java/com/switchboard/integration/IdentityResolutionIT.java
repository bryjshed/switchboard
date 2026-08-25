package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.user.UserService;
import com.switchboard.domain.identity.Identities;
import com.switchboard.domain.identity.VerifiedIdentity;
import com.switchboard.domain.user.User;
import com.switchboard.interfaces.rest.model.UserResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * What a user IS, now that no vendor owns the answer.
 *
 * <p>A user is a row in {@code users} with one or more linked {@code (issuer, subject)} identities.
 * These tests pin the four rules that follow from that: identity lookup is by issuer and subject;
 * a second provider asserting a <b>verified</b> email joins the existing user instead of forking
 * it; an <b>unverified</b> email does not, because it would be an account-takeover path; and a
 * dev-provisioned placeholder row is still adopted by the first real login for that address.
 *
 * <p>Driven through {@link UserService} rather than HTTP because minting genuine tokens from three
 * different IdPs is the subject of {@link SecondProviderIT}; everything under test here lives
 * below token verification.
 */
class IdentityResolutionIT extends IntegrationTestBase {

    private static final String OKTA = "https://example.okta.com/oauth2/default";
    private static final String AUTH0 = "https://example.auth0.com/";

    @Autowired
    private UserService users;

    @Test
    void anIdentityIsFoundByIssuerAndSubject() {
        String email = uniqueEmail("okta-user");
        String subject = "okta|" + UUID.randomUUID();

        User created = resolve(OKTA, subject, email, true);
        User again = resolve(OKTA, subject, email, true);

        assertThat(again.id()).isEqualTo(created.id());
        assertThat(countByEmail(email)).isEqualTo(1);
        assertThat(identities(created.id())).containsExactly(OKTA + "|" + subject);

        // Same subject string, different issuer, is a different identity - subjects are only
        // unique within an issuer, so treating them globally would collide across IdPs.
        User elsewhere = resolve(AUTH0, subject, uniqueEmail("auth0-user"), true);
        assertThat(elsewhere.id()).isNotEqualTo(created.id());
    }

    @Test
    void aSecondProviderWithAVerifiedEmailLinksToTheExistingUser() {
        String email = uniqueEmail("migrating");

        User viaOkta = resolve(OKTA, "okta|" + UUID.randomUUID(), email, true);
        User viaAuth0 = resolve(AUTH0, "auth0|" + UUID.randomUUID(), email, true);

        // One person, one account, two ways in. This is what makes an IdP migration survivable.
        assertThat(viaAuth0.id()).isEqualTo(viaOkta.id());
        assertThat(countByEmail(email)).isEqualTo(1);
        assertThat(identities(viaOkta.id())).hasSize(2);
    }

    @Test
    void anUnverifiedEmailDoesNotLinkToAnExistingUser() {
        String email = uniqueEmail("victim");

        User real = resolve(OKTA, "okta|" + UUID.randomUUID(), email, true);
        User impostor = resolve(AUTH0, "auth0|" + UUID.randomUUID(), email, false);

        // An IdP that lets anyone claim an arbitrary address must not hand them someone's account.
        assertThat(impostor.id()).isNotEqualTo(real.id());
        assertThat(countByEmail(email)).isEqualTo(2);
        assertThat(identities(real.id())).hasSize(1);
        assertThat(identities(impostor.id())).hasSize(1);
    }

    @Test
    void aRealLoginAdoptsTheRowADevTokenProvisioned() {
        String email = uniqueEmail("adoptee");

        UserResponse provisioned = signIn(email);
        assertThat(identities(provisioned.getId()))
            .containsExactly(Identities.DEV_ISSUER + "|" + email);

        // Unverified on purpose: Firebase emulator tokens carry email_verified=false, and this
        // must still work. The candidate holds nothing but a dev placeholder, so it is adopted.
        String subject = "firebase-uid-" + UUID.randomUUID();
        User adopted = resolve(OKTA, subject, email, false);

        assertThat(adopted.id()).isEqualTo(provisioned.getId());
        assertThat(countByEmail(email)).isEqualTo(1);
        assertThat(identities(adopted.id()))
            .containsExactlyInAnyOrder(Identities.DEV_ISSUER + "|" + email, OKTA + "|" + subject);

        // Idempotent: the second visit is a plain identity lookup.
        assertThat(resolve(OKTA, subject, email, false).id()).isEqualTo(provisioned.getId());
        assertThat(countByEmail(email)).isEqualTo(1);

        // And the dev token still resolves to the same person afterwards.
        assertThat(signIn(email).getId()).isEqualTo(provisioned.getId());
        assertThat(countByEmail(email)).isEqualTo(1);
    }

    @Test
    void aDevTokenAdoptsAnExistingRealUser() {
        String email = uniqueEmail("real-first");

        User real = resolve(OKTA, "okta|" + UUID.randomUUID(), email, true);
        UserResponse viaDevToken = signIn(email);

        // Curl testing joins the account that already exists rather than shadowing it - which is
        // what the SDK live-check depends on when it drives a seeded workspace with a dev token.
        assertThat(viaDevToken.getId()).isEqualTo(real.id());
        assertThat(countByEmail(email)).isEqualTo(1);
    }

    private User resolve(String issuer, String subject, String email, boolean emailVerified) {
        return users.resolveIdentity(
                new VerifiedIdentity(issuer, subject, email, null, emailVerified))
            .block(DB_TIMEOUT);
    }

    private List<String> identities(UUID userId) {
        return users.identitiesOf(userId)
            .map(identity -> identity.issuer() + "|" + identity.subject())
            .collectList()
            .block(DB_TIMEOUT);
    }

    private long countByEmail(String email) {
        return selectOne("SELECT count(*) FROM users WHERE email = :email",
            Long.class, Map.of("email", email));
    }
}
