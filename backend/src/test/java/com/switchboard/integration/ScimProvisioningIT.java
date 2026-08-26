package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.PersonalAccessTokenCreateRequest;
import com.switchboard.interfaces.rest.model.PersonalAccessTokenCreatedResponse;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;

/**
 * SCIM 2.0 provisioning, end to end against a real database.
 *
 * <p>The assertions that matter most are the deprovisioning ones. Provisioning that creates
 * accounts and cannot reliably remove access is worse than no provisioning, because it produces
 * confidence without the property.
 */
class ScimProvisioningIT extends IntegrationTestBase {

    private static final String SCIM_JSON = "application/scim+json";

    private String provisioningToken(Workspace workspace) {
        PersonalAccessTokenCreatedResponse created = http.post().uri("/api/users/me/tokens")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new PersonalAccessTokenCreateRequest("scim"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(PersonalAccessTokenCreatedResponse.class)
            .returnResult().getResponseBody();
        return "Bearer " + created.getToken();
    }

    private String scimUserId(Workspace workspace, String auth, String userName) {
        byte[] body = http.get().uri(uri -> uri
                .path("/scim/v2/orgs/{orgId}/Users")
                .queryParam("filter", "userName eq \"" + userName + "\"")
                .build(workspace.orgId()))
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .returnResult()
            .getResponseBody();
        String json = new String(body, java.nio.charset.StandardCharsets.UTF_8);
        int idx = json.indexOf("\"id\":\"");
        return json.substring(idx + 6, json.indexOf('"', idx + 6));
    }

    @Test
    @DisplayName("provisions a new user, who becomes a member of the org")
    void provisions() {
        Workspace workspace = createWorkspace("scim-create");
        String auth = provisioningToken(workspace);
        String email = uniqueEmail("scim-new");

        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("userName", email, "externalId", "idp-1", "active", true))
            .exchange()
            .expectStatus().isCreated()
            .expectHeader().contentTypeCompatibleWith(SCIM_JSON)
            .expectBody()
            .jsonPath("$.schemas[0]").isEqualTo("urn:ietf:params:scim:schemas:core:2.0:User")
            .jsonPath("$.userName").isEqualTo(email)
            .jsonPath("$.externalId").isEqualTo("idp-1")
            .jsonPath("$.active").isEqualTo(true)
            .jsonPath("$.meta.resourceType").isEqualTo("User");

        // Provisioned means a MEMBER, not merely a row: the point of SCIM is that the person can
        // then sign in and do something.
        Long members = selectOne("SELECT count(*) FROM org_memberships WHERE org_id = :orgId",
            Long.class, Map.of("orgId", workspace.orgId()));
        assertThat(members).isEqualTo(2L);
    }

    @Test
    @DisplayName("adopts a person who already had an account rather than creating a second")
    void adoptsExisting() {
        // The normal order of events: people sign in before anyone turns SCIM on. Creating a
        // duplicate account here would split one person's history in two.
        Workspace workspace = createWorkspace("scim-adopt");
        String auth = provisioningToken(workspace);
        String email = uniqueEmail("scim-existing");
        signIn(email);

        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange()
            .expectStatus().isCreated();

        Long rows = selectOne("SELECT count(*) FROM users WHERE lower(email) = :email",
            Long.class, Map.of("email", email.toLowerCase(java.util.Locale.ROOT)));
        assertThat(rows).as("one person, one row").isEqualTo(1L);
    }

    @Test
    @DisplayName("a duplicate userName in the same org is a 409")
    void duplicateConflicts() {
        Workspace workspace = createWorkspace("scim-dupe");
        String auth = provisioningToken(workspace);
        String email = uniqueEmail("scim-dupe-user");

        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange().expectStatus().isCreated();

        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange().expectStatus().isEqualTo(409);
    }

    @Test
    @DisplayName("lists with SCIM's envelope and honours a userName filter")
    void listsAndFilters() {
        Workspace workspace = createWorkspace("scim-list");
        String auth = provisioningToken(workspace);
        String email = uniqueEmail("scim-filtered");
        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange().expectStatus().isCreated();

        http.get().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.schemas[0]").isEqualTo("urn:ietf:params:scim:api:messages:2.0:ListResponse")
            .jsonPath("$.totalResults").isEqualTo(2)
            .jsonPath("$.startIndex").isEqualTo(1);

        http.get().uri(uri -> uri.path("/scim/v2/orgs/{orgId}/Users")
                .queryParam("filter", "userName eq \"" + email + "\"")
                .build(workspace.orgId()))
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.totalResults").isEqualTo(1)
            .jsonPath("$.Resources[0].userName").isEqualTo(email);
    }

    @Test
    @DisplayName("startIndex is 1-based, not 0-based")
    void pagingIsOneBased() {
        // The single most common SCIM integration bug. startIndex=1 must return the FIRST
        // record, and an off-by-one here silently skips a person on every sync.
        Workspace workspace = createWorkspace("scim-page");
        String auth = provisioningToken(workspace);
        for (int i = 0; i < 2; i++) {
            http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
                .header(HttpHeaders.AUTHORIZATION, auth)
                .bodyValue(Map.of("userName", uniqueEmail("scim-page-" + i), "active", true))
                .exchange().expectStatus().isCreated();
        }

        String first = pageFirstUserName(workspace, auth, 1);
        String second = pageFirstUserName(workspace, auth, 2);
        assertThat(first).isNotEqualTo(second);
        // startIndex 1 is the owner, who was created first and is ordered by created_at.
        assertThat(first).isEqualTo(workspace.ownerEmail());
    }

    private String pageFirstUserName(Workspace workspace, String auth, int startIndex) {
        byte[] body = http.get().uri(uri -> uri.path("/scim/v2/orgs/{orgId}/Users")
                .queryParam("startIndex", startIndex)
                .queryParam("count", 1)
                .build(workspace.orgId()))
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isOk()
            .expectBody().returnResult().getResponseBody();
        String json = new String(body, java.nio.charset.StandardCharsets.UTF_8);
        int idx = json.indexOf("\"userName\":\"");
        return json.substring(idx + 12, json.indexOf('"', idx + 12));
    }

    @Test
    @DisplayName("PATCH active:false deactivates, and the deactivated user can no longer sign in")
    void deactivationRevokesAccess() {
        // The assertion this whole feature exists for.
        Workspace workspace = createWorkspace("scim-deactivate");
        String auth = provisioningToken(workspace);
        String email = uniqueEmail("scim-leaver");
        signIn(email);
        addOrgMember(workspace, email, com.switchboard.interfaces.rest.model.OrgRole.MEMBER);

        // They work before.
        http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .exchange().expectStatus().isOk();

        String userId = scimUserId(workspace, auth, email);
        http.patch().uri("/scim/v2/orgs/{orgId}/Users/{userId}", workspace.orgId(), userId)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of(
                "schemas", java.util.List.of("urn:ietf:params:scim:api:messages:2.0:PatchOp"),
                "Operations", java.util.List.of(
                    Map.of("op", "replace", "path", "active", "value", false))))
            .exchange()
            .expectStatus().isOk()
            .expectBody().jsonPath("$.active").isEqualTo(false);

        // And they do NOT work after. If the identity cache were not evicted this would keep
        // passing for five minutes, which is the window deprovisioning exists to close.
        http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .exchange().expectStatus().isForbidden();
    }

    @Test
    @DisplayName("a pathless PATCH deactivates too, which is how Entra sends it")
    void pathlessPatchDeactivates() {
        Workspace workspace = createWorkspace("scim-entra");
        String auth = provisioningToken(workspace);
        String email = uniqueEmail("scim-entra-user");
        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange().expectStatus().isCreated();

        String userId = scimUserId(workspace, auth, email);
        http.patch().uri("/scim/v2/orgs/{orgId}/Users/{userId}", workspace.orgId(), userId)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("Operations", java.util.List.of(
                Map.of("op", "replace", "value", Map.of("active", false)))))
            .exchange()
            .expectStatus().isOk()
            .expectBody().jsonPath("$.active").isEqualTo(false);
    }

    @Test
    @DisplayName("DELETE deactivates rather than deleting, so the audit actor survives")
    void deleteIsDeactivation() {
        Workspace workspace = createWorkspace("scim-delete");
        String auth = provisioningToken(workspace);
        String email = uniqueEmail("scim-deleted");
        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange().expectStatus().isCreated();

        String userId = scimUserId(workspace, auth, email);
        http.delete().uri("/scim/v2/orgs/{orgId}/Users/{userId}", workspace.orgId(), userId)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange().expectStatus().isNoContent();

        Long stillThere = selectOne("SELECT count(*) FROM users WHERE id = :id",
            Long.class, Map.of("id", UUID.fromString(userId)));
        assertThat(stillThere)
            .as("the row must survive - audit entries and change requests name their actor")
            .isEqualTo(1L);

        http.get().uri("/scim/v2/orgs/{orgId}/Users/{userId}", workspace.orgId(), userId)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isOk()
            .expectBody().jsonPath("$.active").isEqualTo(false);
    }

    @Test
    @DisplayName("reactivation restores access")
    void reactivation() {
        Workspace workspace = createWorkspace("scim-reactivate");
        String auth = provisioningToken(workspace);
        String email = uniqueEmail("scim-returner");
        signIn(email);
        addOrgMember(workspace, email, com.switchboard.interfaces.rest.model.OrgRole.MEMBER);
        String userId = scimUserId(workspace, auth, email);

        http.delete().uri("/scim/v2/orgs/{orgId}/Users/{userId}", workspace.orgId(), userId)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange().expectStatus().isNoContent();
        http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .exchange().expectStatus().isForbidden();

        http.patch().uri("/scim/v2/orgs/{orgId}/Users/{userId}", workspace.orgId(), userId)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("Operations", java.util.List.of(
                Map.of("op", "replace", "path", "active", "value", true))))
            .exchange().expectStatus().isOk();

        http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .exchange().expectStatus().isOk();
    }

    @Test
    @DisplayName("another org's provisioning token cannot see or change these users")
    void tenancyIsEnforced() {
        Workspace mine = createWorkspace("scim-mine");
        Workspace theirs = createWorkspace("scim-theirs");
        String mineAuth = provisioningToken(mine);
        String theirsAuth = provisioningToken(theirs);
        String email = uniqueEmail("scim-private");
        http.post().uri("/scim/v2/orgs/{orgId}/Users", mine.orgId())
            .header(HttpHeaders.AUTHORIZATION, mineAuth)
            .bodyValue(Map.of("userName", email, "active", true))
            .exchange().expectStatus().isCreated();
        String userId = scimUserId(mine, mineAuth, email);

        http.get().uri("/scim/v2/orgs/{orgId}/Users", mine.orgId())
            .header(HttpHeaders.AUTHORIZATION, theirsAuth)
            .exchange().expectStatus().isForbidden();

        http.delete().uri("/scim/v2/orgs/{orgId}/Users/{userId}", mine.orgId(), userId)
            .header(HttpHeaders.AUTHORIZATION, theirsAuth)
            .exchange().expectStatus().isForbidden();
    }

    @Test
    @DisplayName("a member without MANAGE_MEMBERS cannot provision")
    void needsManageMembers() {
        Workspace workspace = createWorkspace("scim-perm");
        String memberEmail = uniqueEmail("scim-plain-member");
        signIn(memberEmail);
        addOrgMember(workspace, memberEmail, com.switchboard.interfaces.rest.model.OrgRole.MEMBER);

        PersonalAccessTokenCreatedResponse token = http.post().uri("/api/users/me/tokens")
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(memberEmail))
            .bodyValue(new PersonalAccessTokenCreateRequest("member-token"))
            .exchange().expectStatus().isCreated()
            .expectBody(PersonalAccessTokenCreatedResponse.class).returnResult().getResponseBody();

        http.post().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token.getToken())
            .bodyValue(Map.of("userName", uniqueEmail("nope"), "active", true))
            .exchange().expectStatus().isForbidden();
    }

    @Test
    @DisplayName("unauthenticated SCIM is refused")
    void requiresAuth() {
        Workspace workspace = createWorkspace("scim-anon");
        http.get().uri("/scim/v2/orgs/{orgId}/Users", workspace.orgId())
            .exchange().expectStatus().isUnauthorized();
    }
}
