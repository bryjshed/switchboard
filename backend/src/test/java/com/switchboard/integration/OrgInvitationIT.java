package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.user.UserService;
import com.switchboard.domain.identity.VerifiedIdentity;
import com.switchboard.domain.user.User;
import com.switchboard.interfaces.rest.model.OrgInvitationCreateRequest;
import com.switchboard.interfaces.rest.model.OrgInvitationResponse;
import com.switchboard.interfaces.rest.model.OrgInvitationStatus;
import com.switchboard.interfaces.rest.model.OrgMemberAddRequest;
import com.switchboard.interfaces.rest.model.OrgRole;
import com.switchboard.interfaces.rest.model.PersonalAccessTokenCreateRequest;
import com.switchboard.interfaces.rest.model.PersonalAccessTokenCreatedResponse;
import com.switchboard.interfaces.rest.model.UserResponse;
import com.switchboard.testsupport.TestOidcIssuer;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * Pending invitations, end to end: an admin invites an address nobody has signed in with yet,
 * and that person's first verified sign-in makes them a member with the invited role.
 */
class OrgInvitationIT extends IntegrationTestBase {

    private static final String OKTA = "https://example.okta.com/oauth2/default";
    private static final String AUDIENCE = "switchboard";

    /** A real OIDC issuer, so a test can sign in unverified and then come back verified. */
    private static final TestOidcIssuer IDP = new TestOidcIssuer();

    @Autowired
    private UserService users;

    @AfterAll
    static void stopIssuer() {
        IDP.close();
    }

    @DynamicPropertySource
    static void oidcProvider(DynamicPropertyRegistry registry) {
        registry.add("switchboard.auth.providers[0].id", () -> "test-idp");
        registry.add("switchboard.auth.providers[0].type", () -> "oidc");
        registry.add("switchboard.auth.providers[0].issuer", IDP::issuer);
        registry.add("switchboard.auth.providers[0].jwk-set-uri", IDP::jwkSetUri);
        registry.add("switchboard.auth.providers[0].audience", () -> AUDIENCE);
    }

    @Test
    @DisplayName("unverified first sign-in does not accept; the same identity, once verified, accepts via /users/me")
    void verifyingLaterAcceptsOnUsersMe() {
        Workspace workspace = createWorkspace("invite-verify-later");
        String email = uniqueEmail("firebase-password-user");
        String subject = "uid-" + UUID.randomUUID();
        invite(workspace, email, OrgRole.MEMBER);

        // Firebase email/password sign-up: the first token is unverified.
        String unverified = IDP.mint(subject, AUDIENCE, Map.of("email", email, "email_verified", false));
        UserResponse before = me("Bearer " + unverified);
        assertThat(before.getMemberships()).isEmpty();
        assertThat(listPending(workspace)).hasSize(1);

        // A personal access token proves possession of a secret, not of a mailbox: no acceptance.
        PersonalAccessTokenCreatedResponse pat = http.post().uri("/api/users/me/tokens")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + unverified)
            .bodyValue(new PersonalAccessTokenCreateRequest("cli"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(PersonalAccessTokenCreatedResponse.class)
            .returnResult().getResponseBody();
        assertThat(me("Bearer " + pat.getToken()).getMemberships()).isEmpty();
        assertThat(listPending(workspace)).hasSize(1);

        // They click the verification link; the refreshed token says so. The SAME response
        // carries the new membership.
        String verified = IDP.mint(subject, AUDIENCE, Map.of("email", email, "email_verified", true));
        UserResponse after = me("Bearer " + verified);
        assertThat(after.getId()).isEqualTo(before.getId());
        assertThat(after.getMemberships()).singleElement()
            .satisfies(m -> {
                assertThat(m.getOrgId()).isEqualTo(workspace.orgId());
                assertThat(m.getRole()).isEqualTo(OrgRole.MEMBER);
            });
        assertThat(listPending(workspace)).isEmpty();
        assertThat(auditActions(workspace)).contains("INVITE_ACCEPT");

        // And the permission it implies is live at once, not after the cache TTL.
        http.get().uri(uri -> uri.path("/api/users/me/permissions")
                .queryParam("orgId", workspace.orgId()).build())
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + verified)
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.permissions[?(@ == 'FLAG_READ')]").exists();
    }

    private UserResponse me(String authorization) {
        return http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, authorization)
            .exchange()
            .expectStatus().isOk()
            .expectBody(UserResponse.class)
            .returnResult().getResponseBody();
    }

    @Test
    @DisplayName("invite, then first sign-in: member with the invited role, audited, permitted at once")
    void inviteThenFirstSignIn() {
        Workspace workspace = createWorkspace("invite-accept");
        String email = uniqueEmail("invitee");

        OrgInvitationResponse created = invite(workspace, email.toUpperCase(java.util.Locale.ROOT), OrgRole.OWNER);
        assertThat(created.getStatus()).isEqualTo(OrgInvitationStatus.PENDING);
        assertThat(created.getEmail()).isEqualTo(email.toLowerCase(java.util.Locale.ROOT));
        assertThat(created.getInvitedBy()).isEqualTo(workspace.ownerEmail());
        assertThat(created.getAcceptedAt()).isNull();
        assertThat(listPending(workspace)).extracting(OrgInvitationResponse::getId).containsExactly(created.getId());

        // The very first request the invitee ever makes is an authorization check in the org. The
        // invitation is accepted during authentication, before that check runs.
        http.get().uri(uri -> uri.path("/api/users/me/permissions")
                .queryParam("orgId", workspace.orgId()).build())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.permissions[?(@ == 'FLAG_READ')]").exists()
            .jsonPath("$.permissions[?(@ == 'MANAGE_MEMBERS')]").exists();

        UserResponse me = signIn(email);
        assertThat(me.getMemberships()).singleElement()
            .satisfies(m -> {
                assertThat(m.getOrgId()).isEqualTo(workspace.orgId());
                assertThat(m.getRole()).isEqualTo(OrgRole.OWNER);
            });
        assertThat(listPending(workspace)).isEmpty();
        assertThat(selectOne("SELECT accepted_user_id FROM org_invitations WHERE id = :id",
            UUID.class, Map.of("id", created.getId()))).isEqualTo(me.getId());
        assertThat(auditActions(workspace)).contains("INVITE_CREATE", "INVITE_ACCEPT");
        assertThat(selectOne("""
                SELECT count(*) FROM role_assignments
                WHERE user_id = :userId AND scope_type = 'ORG' AND scope_id = :orgId AND role_key = 'OWNER'
                """, Long.class, Map.of("userId", me.getId(), "orgId", workspace.orgId())))
            .isEqualTo(1L);
    }

    @Test
    @DisplayName("an existing user is added immediately and the invitation comes back ACCEPTED")
    void existingUserIsAddedImmediately() {
        Workspace workspace = createWorkspace("invite-existing");
        String email = uniqueEmail("existing");
        UUID userId = provisionUser(email);

        OrgInvitationResponse result = invite(workspace, email, OrgRole.MEMBER);

        assertThat(result.getStatus()).isEqualTo(OrgInvitationStatus.ACCEPTED);
        assertThat(result.getAcceptedAt()).isNotNull();
        assertThat(signIn(email).getMemberships()).extracting(m -> m.getOrgId()).containsExactly(workspace.orgId());
        assertThat(listPending(workspace)).isEmpty();
        assertThat(userId).isNotNull();

        // Already a member now: a second invite is a conflict, not a silent role change.
        inviteExpecting(workspace, email, OrgRole.OWNER, 409);
    }

    @Test
    @DisplayName("a duplicate pending invitation is a 409")
    void duplicatePendingConflicts() {
        Workspace workspace = createWorkspace("invite-dupe");
        String email = uniqueEmail("dupe");
        invite(workspace, email, OrgRole.MEMBER);

        inviteExpecting(workspace, email, OrgRole.MEMBER, 409);
        inviteExpecting(workspace, email.toUpperCase(java.util.Locale.ROOT), OrgRole.OWNER, 409);
        assertThat(listPending(workspace)).hasSize(1);
    }

    @Test
    @DisplayName("an unverified identity does not accept; a verified one does, on an account of its own")
    void unverifiedIdentityDoesNotAccept() {
        Workspace workspace = createWorkspace("invite-unverified");
        String email = uniqueEmail("claimed");
        invite(workspace, email, OrgRole.MEMBER);

        // An IdP that lets anyone claim an address must not hand them that address's invitation.
        User impostor = resolve("impostor|" + UUID.randomUUID(), email, false);
        assertThat(isMember(workspace, impostor.id())).isFalse();
        assertThat(listPending(workspace)).hasSize(1);

        // The real owner arrives verified. They must NOT be merged into the impostor's account -
        // or the impostor's password would open everything the owner is then granted.
        User real = resolve("real|" + UUID.randomUUID(), email, true);
        assertThat(real.id()).isNotEqualTo(impostor.id());
        assertThat(isMember(workspace, real.id())).isTrue();
        assertThat(isMember(workspace, impostor.id())).isFalse();
        assertThat(listPending(workspace)).isEmpty();
    }

    @Test
    @DisplayName("an unverified existing account is invited, not added; verifying via /users/me joins it")
    void unverifiedExistingAccountGetsAPendingInvitation() {
        Workspace workspace = createWorkspace("invite-squatter");
        String email = uniqueEmail("unverified-account");
        String subject = "uid-" + UUID.randomUUID();
        String unverified = "Bearer " + IDP.mint(subject, AUDIENCE, Map.of("email", email, "email_verified", false));
        UUID accountId = me(unverified).getId();

        // The account exists, but nothing proves its owner holds the mailbox.
        OrgInvitationResponse invitation = invite(workspace, email, OrgRole.MEMBER);
        assertThat(invitation.getStatus()).isEqualTo(OrgInvitationStatus.PENDING);
        assertThat(isMember(workspace, accountId)).isFalse();
        assertThat(me(unverified).getMemberships()).isEmpty();

        // The legacy by-email grant paths refuse the same account, pointing at invitations.
        http.post().uri("/api/orgs/{orgId}/members", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new OrgMemberAddRequest(email, OrgRole.MEMBER))
            .exchange()
            .expectStatus().isEqualTo(409)
            .expectBody()
            .jsonPath("$.message").value(message -> assertThat((String) message).contains("Invite the address"));
        http.post().uri("/api/orgs/{orgId}/role-assignments", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new com.switchboard.interfaces.rest.model.RoleAssignmentCreateRequest(
                com.switchboard.interfaces.rest.model.ScopeType.ORG, workspace.orgId(), "VIEWER").email(email))
            .exchange()
            .expectStatus().isEqualTo(409);
        assertThat(isMember(workspace, accountId)).isFalse();

        // They verify; the refreshed token reaches /users/me and the same response has the org.
        String verified = "Bearer " + IDP.mint(subject, AUDIENCE, Map.of("email", email, "email_verified", true));
        UserResponse after = me(verified);
        assertThat(after.getId()).isEqualTo(accountId);
        assertThat(after.getMemberships()).extracting(m -> m.getOrgId()).containsExactly(workspace.orgId());
        assertThat(selectOne("SELECT email_verified FROM user_identities WHERE subject = :subject",
            Boolean.class, Map.of("subject", subject))).isTrue();
    }

    @Test
    @DisplayName("a verified existing account is added immediately; verification is recorded and never downgraded")
    void verifiedExistingAccountIsAddedImmediately() {
        Workspace first = createWorkspace("invite-verified-a");
        Workspace second = createWorkspace("invite-verified-b");

        // Verified at first sign-in: recorded at link time.
        String email = uniqueEmail("verified-account");
        me("Bearer " + IDP.mint("uid-" + UUID.randomUUID(), AUDIENCE,
            Map.of("email", email, "email_verified", true)));
        assertThat(invite(first, email, OrgRole.MEMBER).getStatus()).isEqualTo(OrgInvitationStatus.ACCEPTED);

        // Unverified at first sign-in, verified later with no invitation waiting: the upgrade on
        // /users/me is what lets the NEXT invite add them directly - and a later unverified
        // token does not take it back.
        String late = uniqueEmail("verified-later");
        String subject = "uid-" + UUID.randomUUID();
        me("Bearer " + IDP.mint(subject, AUDIENCE, Map.of("email", late, "email_verified", false)));
        me("Bearer " + IDP.mint(subject, AUDIENCE, Map.of("email", late, "email_verified", true)));
        me("Bearer " + IDP.mint(subject, AUDIENCE, Map.of("email", late, "email_verified", false)));
        assertThat(invite(second, late, OrgRole.MEMBER).getStatus()).isEqualTo(OrgInvitationStatus.ACCEPTED);
    }

    @Test
    @DisplayName("SCIM does not adopt an unverified account; the employee's verified sign-in joins the SCIM one")
    void scimDoesNotAdoptAnUnverifiedAccount() {
        Workspace workspace = createWorkspace("scim-squatter");
        String email = uniqueEmail("employee");

        // Someone signs up with the employee's address before SCIM runs, without proving it.
        UUID squatter = me("Bearer " + IDP.mint("squatter-" + UUID.randomUUID(), AUDIENCE,
            Map.of("email", email, "email_verified", false))).getId();

        String scim = "Bearer " + http.post().uri("/api/users/me/tokens")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new PersonalAccessTokenCreateRequest("scim"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(PersonalAccessTokenCreatedResponse.class)
            .returnResult().getResponseBody().getToken();
        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, scim)
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange()
            .expectStatus().isCreated();

        // A second account for the address, SCIM-provisioned and the member - not the squatter's.
        assertThat(isMember(workspace, squatter)).isFalse();
        assertThat(selectOne("SELECT count(*) FROM users WHERE lower(email) = lower(:email)",
            Long.class, Map.of("email", email))).isEqualTo(2L);
        UUID scimAccount = selectOne(
            "SELECT id FROM users WHERE lower(email) = lower(:email) AND scim_provisioned",
            UUID.class, Map.of("email", email));
        assertThat(scimAccount).isNotNull().isNotEqualTo(squatter);
        assertThat(isMember(workspace, scimAccount)).isTrue();

        // The employee signs in through the IdP, verified: they land in the SCIM account, even
        // though "prefer an account with a real identity" would have picked the squatter's.
        UserResponse employee = me("Bearer " + IDP.mint("employee-" + UUID.randomUUID(), AUDIENCE,
            Map.of("email", email, "email_verified", true)));
        assertThat(employee.getId()).isEqualTo(scimAccount);
        assertThat(employee.getMemberships()).extracting(m -> m.getOrgId()).containsExactly(workspace.orgId());
        assertThat(isMember(workspace, squatter)).isFalse();
    }

    @Test
    @DisplayName("a user SCIM provisioned before their first sign-in keeps the SCIM role")
    void scimRoleSurvivesAcceptance() {
        Workspace workspace = createWorkspace("invite-scim");
        String email = uniqueEmail("scim-first");
        OrgInvitationResponse pending = invite(workspace, email, OrgRole.OWNER);

        PersonalAccessTokenCreatedResponse token = http.post().uri("/api/users/me/tokens")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new PersonalAccessTokenCreateRequest("scim"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(PersonalAccessTokenCreatedResponse.class)
            .returnResult().getResponseBody();
        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token.getToken())
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange()
            .expectStatus().isCreated();

        UserResponse me = signIn(email);

        // SCIM's default role is MEMBER. The OWNER invitation must not quietly upgrade it: the IdP
        // is the source of truth for someone it provisions.
        assertThat(me.getMemberships()).singleElement()
            .satisfies(m -> assertThat(m.getRole()).isEqualTo(OrgRole.MEMBER));
        assertThat(selectColumn("""
                SELECT role_key FROM role_assignments
                WHERE user_id = :userId AND scope_type = 'ORG' AND scope_id = :orgId
                """, String.class, Map.of("userId", me.getId(), "orgId", workspace.orgId())))
            .containsExactly("MEMBER");
        assertThat(selectOne("SELECT accepted_at IS NOT NULL FROM org_invitations WHERE id = :id",
            Boolean.class, Map.of("id", pending.getId()))).isTrue();
    }

    @Test
    @DisplayName("a revoked invitation is not accepted, and revoking twice is a 404")
    void revokedInvitationIsNotAccepted() {
        Workspace workspace = createWorkspace("invite-revoke");
        String email = uniqueEmail("revoked");
        OrgInvitationResponse pending = invite(workspace, email, OrgRole.MEMBER);

        revoke(workspace, workspace.authorization(), pending.getId()).expectStatus().isNoContent();
        assertThat(listPending(workspace)).isEmpty();

        assertThat(signIn(email).getMemberships()).isEmpty();
        revoke(workspace, workspace.authorization(), pending.getId()).expectStatus().isNotFound();
        assertThat(auditActions(workspace)).contains("INVITE_REVOKE").doesNotContain("INVITE_ACCEPT");

        // Revoked rows do not block a fresh invitation for the same address. They exist now, so
        // this one adds them at once.
        assertThat(invite(workspace, email, OrgRole.MEMBER).getStatus()).isEqualTo(OrgInvitationStatus.ACCEPTED);
    }

    @Test
    @DisplayName("another org's admin, and a plain MEMBER, cannot see or change invitations")
    void invitationsAreScopedToTheOrg() {
        Workspace mine = createWorkspace("invite-mine");
        Workspace theirs = createWorkspace("invite-theirs");
        OrgInvitationResponse pending = invite(mine, uniqueEmail("target"), OrgRole.MEMBER);

        http.get().uri("/api/orgs/{orgId}/invitations", mine.orgId())
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .exchange().expectStatus().isForbidden();
        http.post().uri("/api/orgs/{orgId}/invitations", mine.orgId())
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .bodyValue(new OrgInvitationCreateRequest(uniqueEmail("x"), OrgRole.OWNER))
            .exchange().expectStatus().isForbidden();
        revoke(mine, theirs.authorization(), pending.getId()).expectStatus().isForbidden();
        // Their own org's path with my invitation's id finds nothing.
        revoke(theirs, theirs.authorization(), pending.getId()).expectStatus().isNotFound();

        String member = uniqueEmail("plain-member");
        addOrgMember(mine, member, OrgRole.MEMBER);
        http.get().uri("/api/orgs/{orgId}/invitations", mine.orgId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(member))
            .exchange().expectStatus().isForbidden();

        assertThat(listPending(mine)).hasSize(1);
    }

    @Test
    @DisplayName("adding an unknown email as a member points at invitations")
    void addMemberUnknownEmailSuggestsInviting() {
        Workspace workspace = createWorkspace("invite-hint");

        http.post().uri("/api/orgs/{orgId}/members", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new OrgMemberAddRequest(uniqueEmail("nobody"), OrgRole.MEMBER))
            .exchange()
            .expectStatus().isNotFound()
            .expectBody()
            .jsonPath("$.message").value(message -> assertThat((String) message).contains("invite"));
    }

    // ---------------------------------------------------------------- helpers

    private OrgInvitationResponse invite(Workspace workspace, String email, OrgRole role) {
        return http.post().uri("/api/orgs/{orgId}/invitations", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new OrgInvitationCreateRequest(email, role))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(OrgInvitationResponse.class)
            .returnResult().getResponseBody();
    }

    private void inviteExpecting(Workspace workspace, String email, OrgRole role, int status) {
        http.post().uri("/api/orgs/{orgId}/invitations", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new OrgInvitationCreateRequest(email, role))
            .exchange()
            .expectStatus().isEqualTo(status);
    }

    private List<OrgInvitationResponse> listPending(Workspace workspace) {
        return http.get().uri("/api/orgs/{orgId}/invitations", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBodyList(OrgInvitationResponse.class)
            .returnResult().getResponseBody();
    }

    private org.springframework.test.web.reactive.server.WebTestClient.ResponseSpec revoke(
        Workspace workspace, String authorization, UUID invitationId) {
        return http.delete().uri("/api/orgs/{orgId}/invitations/{id}", workspace.orgId(), invitationId)
            .header(HttpHeaders.AUTHORIZATION, authorization)
            .exchange();
    }

    /** Through the HTTP audit feed, which also proves the new actions map onto the API enum. */
    private List<String> auditActions(Workspace workspace) {
        return http.get().uri("/api/orgs/{orgId}/audit", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(com.switchboard.interfaces.rest.model.AuditListResponse.class)
            .returnResult().getResponseBody()
            .getItems().stream()
            .map(entry -> entry.getAction().getValue())
            .toList();
    }

    private boolean isMember(Workspace workspace, UUID userId) {
        return selectOne("SELECT count(*) FROM org_memberships WHERE org_id = :orgId AND user_id = :userId",
            Long.class, Map.of("orgId", workspace.orgId(), "userId", userId)) > 0;
    }

    private User resolve(String subject, String email, boolean emailVerified) {
        return users.resolveIdentity(new VerifiedIdentity(OKTA, subject, email, null, emailVerified))
            .block(DB_TIMEOUT);
    }
}
