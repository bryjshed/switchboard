package com.switchboard.application.org;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.org.InvitationStatus;
import com.switchboard.domain.org.OrgInvitation;
import com.switchboard.domain.org.OrgInvitationRepository;
import com.switchboard.domain.org.OrgRepository;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserRepository;
import com.switchboard.infrastructure.notify.CacheInvalidationPublisher;
import com.switchboard.interfaces.security.AuthenticatedUser;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

class InvitationServiceTest {

    private static final String ADMIN_EMAIL = "admin@acme.test";

    private final UUID orgId = UUID.randomUUID();
    private final AuthenticatedUser admin =
        new AuthenticatedUser(UUID.randomUUID(), ADMIN_EMAIL, "switchboard:dev", ADMIN_EMAIL, ADMIN_EMAIL);

    private OrgInvitationRepository invitations;
    private OrgRepository orgs;
    private UserRepository users;
    private OrgService orgService;
    private OrgAccessService access;
    private AuditWriter audit;
    private InvitationService service;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        invitations = mock(OrgInvitationRepository.class);
        orgs = mock(OrgRepository.class);
        users = mock(UserRepository.class);
        orgService = mock(OrgService.class);
        access = mock(OrgAccessService.class);
        audit = mock(AuditWriter.class);
        TransactionalOperator tx = mock(TransactionalOperator.class);
        lenient().when(tx.transactional(any(Mono.class))).thenAnswer(inv -> inv.getArgument(0));
        lenient().when(access.requireOrgPermission(orgId, admin.userId(), Permission.MANAGE_MEMBERS))
            .thenReturn(Mono.just("OWNER"));
        lenient().when(audit.insert(any(), any(), any(), any(), anyString(), anyString(), any(), any(), any(), any()))
            .thenReturn(Mono.empty());
        lenient().when(users.findVerifiedByEmail(anyString())).thenReturn(Mono.empty());
        lenient().when(users.findByEmailPreferringReal(anyString())).thenReturn(Mono.empty());
        lenient().when(orgs.hasMemberWithEmail(any(), anyString())).thenReturn(Mono.just(false));
        lenient().when(orgs.findMemberRole(any(), any())).thenReturn(Mono.empty());
        lenient().when(orgService.provisionMember(any(), any(), anyString(), anyString())).thenReturn(Mono.empty());
        lenient().when(invitations.markPendingAccepted(any(), anyString(), any())).thenReturn(Flux.empty());
        service = new InvitationService(invitations, orgs, users, orgService, access, audit,
            mock(CacheInvalidationPublisher.class), tx);
    }

    // ---------------------------------------------------------------- invite

    @Test
    void aVerifiedExistingUserIsAddedImmediatelyAndTheInvitationComesBackAccepted() {
        User bob = user("bob@acme.test", false);
        when(users.findVerifiedByEmail("bob@acme.test")).thenReturn(Mono.just(bob));
        when(invitations.createAccepted(orgId, "bob@acme.test", "MEMBER", ADMIN_EMAIL, bob.id()))
            .thenReturn(Mono.just(accepted(orgId, "bob@acme.test", "MEMBER", bob.id())));

        OrgInvitation result = service.invite(orgId, admin, "Bob@Acme.test", "MEMBER").block();

        assertThat(result.status()).isEqualTo(InvitationStatus.ACCEPTED);
        verify(orgService).provisionMember(orgId, bob.id(), "MEMBER", ADMIN_EMAIL);
        verify(invitations, never()).createPending(any(), anyString(), anyString(), anyString());
        verifyAudit("MEMBER_ADD");
    }

    @Test
    void anUnknownEmailBecomesAPendingInvitationStoredLowercased() {
        when(invitations.createPending(orgId, "new@acme.test", "OWNER", ADMIN_EMAIL))
            .thenReturn(Mono.just(pending(orgId, "new@acme.test", "OWNER")));

        OrgInvitation result = service.invite(orgId, admin, "  New@ACME.test ", "OWNER").block();

        assertThat(result.status()).isEqualTo(InvitationStatus.PENDING);
        verify(orgService, never()).provisionMember(any(), any(), anyString(), anyString());
        verifyAudit("INVITE_CREATE");
    }

    @Test
    void anUnverifiedExistingAccountIsInvitedLikeAStrangerNotAdded() {
        // An account exists for the address, but nothing has proven its owner holds the mailbox:
        // it could be anyone who signed up with victim@acme.test first.
        User squatter = user("victim@acme.test", false);
        lenient().when(users.findByEmailPreferringReal("victim@acme.test")).thenReturn(Mono.just(squatter));
        when(invitations.createPending(orgId, "victim@acme.test", "MEMBER", ADMIN_EMAIL))
            .thenReturn(Mono.just(pending(orgId, "victim@acme.test", "MEMBER")));

        OrgInvitation result = service.invite(orgId, admin, "victim@acme.test", "MEMBER").block();

        assertThat(result.status()).isEqualTo(InvitationStatus.PENDING);
        verify(orgService, never()).provisionMember(any(), any(), anyString(), anyString());
        verifyAudit("INVITE_CREATE");
    }

    @Test
    void aDuplicatePendingInvitationIsAConflict() {
        when(invitations.createPending(orgId, "dup@acme.test", "MEMBER", ADMIN_EMAIL))
            .thenReturn(Mono.error(new DataIntegrityViolationException("uq_org_invitations_pending")));

        assertThatThrownBy(() -> service.invite(orgId, admin, "dup@acme.test", "MEMBER").block())
            .isInstanceOf(ConflictException.class)
            .hasMessageContaining("already pending");
    }

    @Test
    void invitingSomeoneWhoIsAlreadyAMemberIsAConflictAndGrantsNothing() {
        when(orgs.hasMemberWithEmail(orgId, "bob@acme.test")).thenReturn(Mono.just(true));

        assertThatThrownBy(() -> service.invite(orgId, admin, "bob@acme.test", "OWNER").block())
            .isInstanceOf(ConflictException.class);
        verify(orgService, never()).provisionMember(any(), any(), anyString(), anyString());
    }

    @Test
    void invitingRequiresManageMembers() {
        AuthenticatedUser member = new AuthenticatedUser(
            UUID.randomUUID(), "m@acme.test", "switchboard:dev", "m", "m@acme.test");
        when(access.requireOrgPermission(orgId, member.userId(), Permission.MANAGE_MEMBERS))
            .thenReturn(Mono.error(new ForbiddenException("Requires the MANAGE_MEMBERS permission")));

        assertThatThrownBy(() -> service.invite(orgId, member, "x@acme.test", "MEMBER").block())
            .isInstanceOf(ForbiddenException.class);
        verifyNoInteractions(invitations, users, orgService);
    }

    @Test
    void aBlankEmailIsRejectedBeforeAnythingElse() {
        assertThatThrownBy(() -> service.invite(orgId, admin, "  ", "MEMBER").block())
            .isInstanceOf(ValidationException.class);
        verifyNoInteractions(access, invitations);
    }

    // ---------------------------------------------------------------- acceptance

    @Test
    void acceptingProvisionsTheInvitedRoleWithTheInviterAsGrantor() {
        User carol = user("carol@acme.test", false);
        OrgInvitation invite = pending(orgId, "carol@acme.test", "OWNER");
        when(invitations.findPendingByEmail("carol@acme.test")).thenReturn(Flux.just(invite));
        when(invitations.markAccepted(invite.id(), carol.id()))
            .thenReturn(Mono.just(accepted(orgId, "carol@acme.test", "OWNER", carol.id())));

        List<OrgInvitation> result = service.acceptPendingFor(carol, "Carol@acme.test").collectList().block();

        assertThat(result).hasSize(1);
        verify(orgService).provisionMember(orgId, carol.id(), "OWNER", ADMIN_EMAIL);
        verify(audit).insert(eq(orgId), isNull(), isNull(), isNull(), eq("INVITE_ACCEPT"),
            eq("carol@acme.test"), anyString(), isNull(), isNull(), isNull());
    }

    @Test
    void anExistingMemberIsNotReGrantedSoAScimRoleSurvives() {
        User dave = user("dave@acme.test", false);
        OrgInvitation invite = pending(orgId, "dave@acme.test", "OWNER");
        when(invitations.findPendingByEmail("dave@acme.test")).thenReturn(Flux.just(invite));
        when(invitations.markAccepted(invite.id(), dave.id()))
            .thenReturn(Mono.just(accepted(orgId, "dave@acme.test", "OWNER", dave.id())));
        when(orgs.findMemberRole(orgId, dave.id())).thenReturn(Mono.just("MEMBER"));

        List<OrgInvitation> result = service.acceptPendingFor(dave, "dave@acme.test").collectList().block();

        assertThat(result).hasSize(1);
        verify(orgService, never()).provisionMember(any(), any(), anyString(), anyString());
        verifyAudit("INVITE_ACCEPT");
    }

    @Test
    void anInvitationRevokedBeforeTheUpdateLandsIsNotAccepted() {
        User erin = user("erin@acme.test", false);
        OrgInvitation invite = pending(orgId, "erin@acme.test", "MEMBER");
        when(invitations.findPendingByEmail("erin@acme.test")).thenReturn(Flux.just(invite));
        // The conditional UPDATE found the row no longer pending.
        when(invitations.markAccepted(invite.id(), erin.id())).thenReturn(Mono.empty());

        List<OrgInvitation> result = service.acceptPendingFor(erin, "erin@acme.test").collectList().block();

        assertThat(result).isEmpty();
        verify(orgService, never()).provisionMember(any(), any(), anyString(), anyString());
    }

    @Test
    void oneFailingInvitationDoesNotBlockTheOthers() {
        User frank = user("frank@acme.test", false);
        UUID otherOrg = UUID.randomUUID();
        OrgInvitation broken = pending(orgId, "frank@acme.test", "MEMBER");
        OrgInvitation fine = pending(otherOrg, "frank@acme.test", "MEMBER");
        when(invitations.findPendingByEmail("frank@acme.test")).thenReturn(Flux.just(broken, fine));
        when(invitations.markAccepted(broken.id(), frank.id())).thenReturn(Mono.error(new IllegalStateException("x")));
        when(invitations.markAccepted(fine.id(), frank.id()))
            .thenReturn(Mono.just(accepted(otherOrg, "frank@acme.test", "MEMBER", frank.id())));

        List<OrgInvitation> result = service.acceptPendingFor(frank, "frank@acme.test").collectList().block();

        assertThat(result).extracting(OrgInvitation::orgId).containsExactly(otherOrg);
    }

    @Test
    void aDeactivatedUserAcceptsNothing() {
        User gone = user("gone@acme.test", true);

        assertThat(service.acceptPendingFor(gone, "gone@acme.test").collectList().block()).isEmpty();
        verifyNoInteractions(invitations);
    }

    @Test
    void theSessionPathLoadsNoUserWhenNothingIsPending() {
        UUID userId = UUID.randomUUID();
        when(invitations.findPendingByEmail("nobody@acme.test")).thenReturn(Flux.empty());

        assertThat(service.acceptPendingForSession(userId, "Nobody@acme.test").collectList().block()).isEmpty();
        verify(users, never()).findById(any());
    }

    @Test
    void theSessionPathAcceptsForTheSessionsUser() {
        User hana = user("hana@acme.test", false);
        OrgInvitation invite = pending(orgId, "hana@acme.test", "MEMBER");
        when(invitations.findPendingByEmail("hana@acme.test")).thenReturn(Flux.just(invite));
        when(users.findById(hana.id())).thenReturn(Mono.just(hana));
        when(invitations.markAccepted(invite.id(), hana.id()))
            .thenReturn(Mono.just(accepted(orgId, "hana@acme.test", "MEMBER", hana.id())));

        assertThat(service.acceptPendingForSession(hana.id(), "hana@acme.test").collectList().block()).hasSize(1);
        verify(orgService).provisionMember(orgId, hana.id(), "MEMBER", ADMIN_EMAIL);
    }

    @Test
    void theSessionPathSkipsADeactivatedUser() {
        User gone = user("gone@acme.test", true);
        when(invitations.findPendingByEmail("gone@acme.test"))
            .thenReturn(Flux.just(pending(orgId, "gone@acme.test", "MEMBER")));
        when(users.findById(gone.id())).thenReturn(Mono.just(gone));

        assertThat(service.acceptPendingForSession(gone.id(), "gone@acme.test").collectList().block()).isEmpty();
        verify(invitations, never()).markAccepted(any(), any());
    }

    // ---------------------------------------------------------------- fixtures

    private void verifyAudit(String action) {
        verify(audit).insert(eq(orgId), isNull(), isNull(), isNull(), eq(action),
            anyString(), anyString(), isNull(), isNull(), isNull());
    }

    private static User user(String email, boolean deactivated) {
        return new User(UUID.randomUUID(), email, null, false, deactivated);
    }

    private static OrgInvitation pending(UUID orgId, String email, String role) {
        return new OrgInvitation(UUID.randomUUID(), orgId, email, role, ADMIN_EMAIL, Instant.now(),
            null, null, null);
    }

    private static OrgInvitation accepted(UUID orgId, String email, String role, UUID userId) {
        return new OrgInvitation(UUID.randomUUID(), orgId, email, role, ADMIN_EMAIL, Instant.now(),
            Instant.now(), userId, null);
    }
}
