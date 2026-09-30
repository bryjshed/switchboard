package com.switchboard.application.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.cache.SwitchboardCache;
import com.switchboard.application.org.InvitationService;
import com.switchboard.domain.identity.Identities;
import com.switchboard.domain.identity.VerifiedIdentity;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserIdentity;
import com.switchboard.domain.user.UserRepository;
import java.time.Instant;
import java.util.UUID;
import java.util.function.Function;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.r2dbc.core.DatabaseClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * The sign-in hook for pending invitations. Only an email the provider vouched for may accept
 * one - the same rule as linking by email, because an unverified address is anybody's.
 */
class UserServiceInvitationTest {

    private static final String OKTA = "https://example.okta.com/oauth2/default";
    private static final String EMAIL = "invitee@acme.test";

    private UserRepository users;
    private InvitationService invitations;
    private UserService service;
    private User created;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        users = mock(UserRepository.class);
        invitations = mock(InvitationService.class);
        CacheRegistry caches = mock(CacheRegistry.class);
        SwitchboardCache<String, User> cache = mock(SwitchboardCache.class);
        when(cache.get(anyString(), any())).thenAnswer(inv ->
            ((Function<String, Mono<User>>) inv.getArgument(1)).apply(inv.getArgument(0)));
        when(caches.<User>cache(CacheName.USER_IDENTITY)).thenReturn(cache);

        created = new User(UUID.randomUUID(), EMAIL, null, false, false);
        when(users.findByIssuerAndSubject(anyString(), anyString())).thenReturn(Mono.empty());
        when(users.findByEmailPreferringReal(anyString())).thenReturn(Mono.empty());
        when(users.findVerifiedByEmail(anyString())).thenReturn(Mono.empty());
        when(users.identitiesOf(any())).thenReturn(Flux.empty());
        when(users.create(anyString(), any())).thenReturn(Mono.just(created));
        when(users.linkIdentity(any(), anyString(), anyString(), anyBoolean())).thenAnswer(inv -> Mono.just(
            new UserIdentity(inv.getArgument(0), inv.getArgument(1), inv.getArgument(2), Instant.now(),
                inv.getArgument(3))));
        when(users.markEmailVerified(anyString(), anyString())).thenReturn(Mono.empty());
        when(invitations.acceptPendingFor(any(), anyString())).thenReturn(Flux.empty());

        service = new UserService(users, mock(DatabaseClient.class), caches, invitations);
    }

    @Test
    void anUnverifiedEmailDoesNotAcceptInvitations() {
        User user = resolve(OKTA, false);

        assertThat(user.id()).isEqualTo(created.id());
        verify(invitations, never()).acceptPendingFor(any(), anyString());
    }

    @Test
    void aVerifiedEmailAcceptsInvitationsForThatEmail() {
        resolve(OKTA, true);

        verify(invitations).acceptPendingFor(created, EMAIL);
    }

    @Test
    void aDevTokenCountsAsVouchedFor() {
        resolve(Identities.DEV_ISSUER, false);

        verify(invitations).acceptPendingFor(created, EMAIL);
    }

    @Test
    void aFailureWhileAcceptingNeverBlocksSignIn() {
        when(invitations.acceptPendingFor(any(), anyString()))
            .thenReturn(Flux.error(new IllegalStateException("database on fire")));

        assertThat(resolve(OKTA, true).id()).isEqualTo(created.id());
    }

    @Test
    void theLinkRecordsWhetherTheTokenVouchedForTheEmail() {
        resolve(OKTA, false);
        verify(users).linkIdentity(eq(created.id()), eq(OKTA), anyString(), eq(false));

        resolve(OKTA, true);
        verify(users).linkIdentity(eq(created.id()), eq(OKTA), anyString(), eq(true));

        resolve(Identities.DEV_ISSUER, false);
        verify(users).linkIdentity(eq(created.id()), eq(Identities.DEV_ISSUER), anyString(), eq(true));
    }

    @Test
    void aVerifiedTokenJoinsTheVerifiedAccountNotTheSquattersOne() {
        // Two accounts share the address: a squatter's unverified sign-up (which the old
        // "prefer real" ordering would pick) and one SCIM created for the actual employee.
        User scimAccount = new User(UUID.randomUUID(), EMAIL, null, false, false);
        User squatter = new User(UUID.randomUUID(), EMAIL, null, false, false);
        when(users.findVerifiedByEmail(EMAIL)).thenReturn(Mono.just(scimAccount));
        when(users.findByEmailPreferringReal(EMAIL)).thenReturn(Mono.just(squatter));

        User resolved = resolve(OKTA, true);

        assertThat(resolved.id()).isEqualTo(scimAccount.id());
        verify(users).linkIdentity(eq(scimAccount.id()), eq(OKTA), anyString(), eq(true));
        verify(users, never()).create(anyString(), any());
    }

    @Test
    void anUnverifiedTokenDoesNotAdoptAnAccountWithNoIdentities() {
        User scimAccount = new User(UUID.randomUUID(), EMAIL, null, false, false);
        when(users.findByEmailPreferringReal(EMAIL)).thenReturn(Mono.just(scimAccount));

        User resolved = resolve(OKTA, false);

        assertThat(resolved.id()).isEqualTo(created.id());
    }

    @Test
    void aSessionWithoutAVerifiedEmailDoesNothing() {
        service.onVerifiedSession(created.id(), EMAIL, OKTA, "sub", null).block();

        verify(users, never()).markEmailVerified(anyString(), anyString());
        verify(invitations, never()).acceptPendingForSession(any(), anyString());
    }

    @Test
    void aVerifiedSessionUpgradesTheIdentityAndAccepts() {
        when(invitations.acceptPendingForSession(any(), anyString())).thenReturn(Flux.empty());

        service.onVerifiedSession(created.id(), EMAIL, OKTA, "sub", "INVITEE@acme.test").block();

        verify(users).markEmailVerified(OKTA, "sub");
        verify(invitations).acceptPendingForSession(created.id(), "INVITEE@acme.test");
    }

    @Test
    void aVerifiedTokenForADifferentAddressDoesNotVerifyTheAccount() {
        when(invitations.acceptPendingForSession(any(), anyString())).thenReturn(Flux.empty());

        service.onVerifiedSession(created.id(), EMAIL, OKTA, "sub", "someone-else@acme.test").block();

        verify(users, never()).markEmailVerified(anyString(), anyString());
    }

    @Test
    void aSessionFailureIsSwallowed() {
        when(invitations.acceptPendingForSession(any(), anyString()))
            .thenReturn(Flux.error(new IllegalStateException("database on fire")));

        service.onVerifiedSession(created.id(), EMAIL, OKTA, "sub", EMAIL).block();

        verify(invitations).acceptPendingForSession(created.id(), EMAIL);
    }

    private User resolve(String issuer, boolean emailVerified) {
        return service.resolveIdentity(
                new VerifiedIdentity(issuer, "subject-" + UUID.randomUUID(), EMAIL, null, emailVerified))
            .block();
    }
}
