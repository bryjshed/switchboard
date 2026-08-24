package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.EnvironmentCreateRequest;
import com.switchboard.interfaces.rest.model.FlagCreateRequest;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagKind;
import com.switchboard.interfaces.rest.model.MyPermissionsResponse;
import com.switchboard.interfaces.rest.model.OrgMemberAddRequest;
import com.switchboard.interfaces.rest.model.OrgRole;
import com.switchboard.interfaces.rest.model.OrgSettingsUpdateRequest;
import com.switchboard.interfaces.rest.model.Permission;
import com.switchboard.interfaces.rest.model.ProjectCreateRequest;
import com.switchboard.interfaces.rest.model.RoleListResponse;
import com.switchboard.interfaces.rest.model.ScopeType;
import com.switchboard.interfaces.rest.model.SdkKeyCreateRequest;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * Scoped roles, and the promise that nothing about the old OWNER/MEMBER world
 * changed underneath them.
 *
 * <p>The rule under test throughout is UNION: effective permissions at an
 * environment are everything the caller holds at that environment, at its
 * project, and at its org, added together. A narrow grant adds capability and
 * never removes any.
 */
class ScopedRbacIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    private Workspace workspace;
    private String viewerEmail;
    private String writerEmail;
    private String approverEmail;

    @BeforeEach
    void seedPeople() {
        workspace = createWorkspace("rbac");
        viewerEmail = uniqueEmail("viewer");
        writerEmail = uniqueEmail("writer");
        approverEmail = uniqueEmail("approver");
    }

    // ---------------------------------------------------------------- catalogue

    @Test
    void theRoleCatalogueShipsTheBuiltInsWithTheirPermissions() {
        RoleListResponse roles = http.get().uri("/api/roles")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(RoleListResponse.class)
            .returnResult().getResponseBody();

        assertThat(roles.getItems()).extracting("key")
            .contains("OWNER", "ADMIN", "MEMBER", "MAINTAINER", "WRITER", "APPROVER", "VIEWER");
        assertThat(permissionsOfRole(roles, "OWNER")).contains(Permission.MANAGE_SETTINGS);
        assertThat(permissionsOfRole(roles, "ADMIN")).doesNotContain(Permission.MANAGE_SETTINGS);
        assertThat(permissionsOfRole(roles, "WRITER"))
            .contains(Permission.FLAG_WRITE)
            .doesNotContain(Permission.APPROVE_CHANGES, Permission.FLAG_KILL);
        assertThat(permissionsOfRole(roles, "APPROVER"))
            .contains(Permission.APPROVE_CHANGES)
            .doesNotContain(Permission.FLAG_WRITE);
        assertThat(permissionsOfRole(roles, "VIEWER"))
            .containsExactlyInAnyOrder(Permission.FLAG_READ, Permission.VIEW_AUDIT);
    }

    // ---------------------------------------------------------------- resolution

    @Test
    void permissionsAreTheUnionOfEveryScopeThatContainsTheOne() {
        UUID envId = workspace.environmentId(ENV_KEY);
        // The same person, three grants, three widths.
        grantRole(workspace, viewerEmail, ScopeType.ORG, workspace.orgId(), "VIEWER");
        grantRole(workspace, viewerEmail, ScopeType.PROJECT, workspace.projectId(), "WRITER");
        grantRole(workspace, viewerEmail, ScopeType.ENVIRONMENT, envId, "APPROVER");

        // At the org: only what the org grant gives.
        assertThat(permissionsAt(viewerEmail, "orgId", workspace.orgId()))
            .containsExactlyInAnyOrder(Permission.FLAG_READ, Permission.VIEW_AUDIT);

        // At the project: org + project.
        assertThat(permissionsAt(viewerEmail, "projectId", workspace.projectId()))
            .contains(Permission.FLAG_READ, Permission.FLAG_WRITE, Permission.SEGMENT_WRITE)
            .doesNotContain(Permission.APPROVE_CHANGES);

        // At the environment: org + project + environment.
        assertThat(permissionsAt(viewerEmail, "envId", envId))
            .contains(Permission.FLAG_READ, Permission.FLAG_WRITE, Permission.APPROVE_CHANGES);

        // A sibling environment sees no trace of the environment-scoped grant.
        assertThat(permissionsAt(viewerEmail, "envId", workspace.environmentId("staging")))
            .contains(Permission.FLAG_WRITE)
            .doesNotContain(Permission.APPROVE_CHANGES);
    }

    @Test
    void aScopedGrantIsStandingOfItsOwnWithoutAnyOrgMembership() {
        grantRole(workspace, viewerEmail, ScopeType.PROJECT, workspace.projectId(), "VIEWER");
        createBooleanFlag(workspace, "scoped-read");

        // Reads work...
        http.get().uri("/api/projects/{projectId}/flags", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(viewerEmail))
            .exchange()
            .expectStatus().isOk();

        // ...and a stranger with no grant at all still cannot see the project.
        http.get().uri("/api/projects/{projectId}/flags", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(uniqueEmail("stranger")))
            .exchange()
            .expectStatus().isForbidden();
    }

    // ---------------------------------------------------------------- gates

    @Test
    void aViewerCannotWrite() {
        grantRole(workspace, viewerEmail, ScopeType.PROJECT, workspace.projectId(), "VIEWER");
        FlagDetailResponse flag = createBooleanFlag(workspace, "viewer-cannot-write");
        String auth = bearerDevToken(viewerEmail);

        http.post().uri("/api/projects/{projectId}/flags", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(new FlagCreateRequest("nope", "Nope", FlagKind.BOOLEAN))
            .exchange()
            .expectStatus().isForbidden();

        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(serveRequest(flag, ENV_KEY, "true", null))
            .exchange()
            .expectStatus().isForbidden();

        // The flag really did not move.
        assertThat(headVersion(flag.getId(), workspace.environmentId(ENV_KEY))).isEqualTo(1);
    }

    @Test
    void aWriterCanWriteButCannotApproveKillOrRollBack() {
        UUID envId = workspace.environmentId(ENV_KEY);
        grantRole(workspace, writerEmail, ScopeType.ENVIRONMENT, envId, "WRITER");
        FlagDetailResponse flag = createBooleanFlag(workspace, "writer-limits");
        String auth = bearerDevToken(writerEmail);

        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(serveRequest(flag, ENV_KEY, "true", 1))
            .exchange()
            .expectStatus().isOk();

        http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/kill-switch",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(java.util.Map.of("active", true))
            .exchange()
            .expectStatus().isForbidden();

        http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/rollback",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(java.util.Map.of("toVersion", 1))
            .exchange()
            .expectStatus().isForbidden();

        assertThat(permissionsAt(writerEmail, "envId", envId))
            .doesNotContain(Permission.APPROVE_CHANGES);
    }

    @Test
    void anApproverReadsButDoesNotWrite() {
        UUID envId = workspace.environmentId(ENV_KEY);
        grantRole(workspace, approverEmail, ScopeType.PROJECT, workspace.projectId(), "VIEWER");
        grantRole(workspace, approverEmail, ScopeType.ENVIRONMENT, envId, "APPROVER");
        FlagDetailResponse flag = createBooleanFlag(workspace, "approver-limits");

        http.get().uri("/api/projects/{projectId}/flags/{flagKey}", workspace.projectId(), flag.getKey())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approverEmail))
            .exchange()
            .expectStatus().isOk();

        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approverEmail))
            .bodyValue(serveRequest(flag, ENV_KEY, "true", 1))
            .exchange()
            .expectStatus().isForbidden();
    }

    /**
     * Containment runs one way. An environment grant is authority inside that
     * environment; it is deliberately NOT project-wide read, or a VIEWER on dev
     * would be able to read production. The one project-scoped route that gives
     * way is the change-request listing, and only when it is narrowed to the
     * environment the caller actually holds.
     */
    @Test
    void anEnvironmentGrantDoesNotRollUpIntoProjectWideRead() {
        UUID envId = workspace.environmentId(ENV_KEY);
        grantRole(workspace, approverEmail, ScopeType.ENVIRONMENT, envId, "APPROVER");
        FlagDetailResponse flag = createBooleanFlag(workspace, "no-roll-up");
        String auth = bearerDevToken(approverEmail);

        http.get().uri("/api/projects/{projectId}/flags/{flagKey}", workspace.projectId(), flag.getKey())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isForbidden();
        http.get().uri("/api/projects/{projectId}/change-requests", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isForbidden();

        // Their own review queue, narrowed to the environment they hold, is visible.
        http.get().uri("/api/projects/{projectId}/change-requests?envKey={envKey}",
                workspace.projectId(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isOk();
    }

    // ---------------------------------------------------------------- compatibility

    @Test
    void alegacyMemberStillDoesExactlyWhatAMemberCouldDoBefore() {
        String memberEmail = uniqueEmail("legacy-member");
        addOrgMember(workspace, memberEmail, OrgRole.MEMBER);
        FlagDetailResponse flag = createBooleanFlag(workspace, "legacy-member");
        String auth = bearerDevToken(memberEmail);

        // Allowed before, allowed now: flags, kill switch, rollback, projects, audit.
        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(serveRequest(flag, ENV_KEY, "true", 1))
            .exchange()
            .expectStatus().isOk();
        http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/kill-switch",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(java.util.Map.of("active", true))
            .exchange()
            .expectStatus().isOk();
        http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/rollback",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(java.util.Map.of("toVersion", 1))
            .exchange()
            .expectStatus().isOk();
        http.post().uri("/api/orgs/{orgId}/projects", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(new ProjectCreateRequest("member-made", "Member Made"))
            .exchange()
            .expectStatus().isCreated();
        http.get().uri("/api/projects/{projectId}/audit", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isOk();

        // Refused before, refused now: members, keys, org settings, new environments.
        http.post().uri("/api/orgs/{orgId}/members", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(new OrgMemberAddRequest(uniqueEmail("intruder"), OrgRole.MEMBER))
            .exchange()
            .expectStatus().isForbidden();
        http.post().uri("/api/environments/{envId}/sdk-keys", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(new SdkKeyCreateRequest().label("nope"))
            .exchange()
            .expectStatus().isForbidden();
        http.put().uri("/api/orgs/{orgId}/settings", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(new OrgSettingsUpdateRequest().aiEnabled(false))
            .exchange()
            .expectStatus().isForbidden();
        http.post().uri("/api/projects/{projectId}/environments", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(new EnvironmentCreateRequest("qa", "QA"))
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    void theOwnerKeepsEverythingIncludingTheOrgRoleInResponses() {
        assertThat(permissionsAt(workspace.ownerEmail(), "orgId", workspace.orgId()))
            .contains(Permission.MANAGE_SETTINGS, Permission.MANAGE_MEMBERS,
                Permission.MANAGE_SDK_KEYS, Permission.APPROVE_CHANGES);

        // The legacy role string is still what the org endpoints report.
        http.get().uri("/api/orgs/{orgId}", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.role").isEqualTo("OWNER");
    }

    @Test
    void grantingAndRevokingIsOwnerOnlyAndCannotReachAnotherOrgsScope() {
        String outsiderEmail = uniqueEmail("outsider");
        addOrgMember(workspace, outsiderEmail, OrgRole.MEMBER);

        // A plain member has no MANAGE_MEMBERS, so it cannot hand out roles.
        http.post().uri("/api/orgs/{orgId}/role-assignments", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(outsiderEmail))
            .bodyValue(new com.switchboard.interfaces.rest.model.RoleAssignmentCreateRequest(
                ScopeType.PROJECT, workspace.projectId(), "ADMIN").email(outsiderEmail))
            .exchange()
            .expectStatus().isForbidden();

        // An owner cannot reach into a scope that belongs to a different org.
        Workspace other = createWorkspace("rbac-other");
        http.post().uri("/api/orgs/{orgId}/role-assignments", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new com.switchboard.interfaces.rest.model.RoleAssignmentCreateRequest(
                ScopeType.PROJECT, other.projectId(), "ADMIN").email(outsiderEmail))
            .exchange()
            .expectStatus().isNotFound();

        // Revoking really removes the permission.
        UUID envId = workspace.environmentId(ENV_KEY);
        UUID assignmentId = grantRole(workspace, approverEmail, ScopeType.ENVIRONMENT, envId, "APPROVER")
            .getId();
        assertThat(permissionsAt(approverEmail, "envId", envId)).contains(Permission.APPROVE_CHANGES);
        http.delete()
            .uri("/api/orgs/{orgId}/role-assignments/{assignmentId}", workspace.orgId(), assignmentId)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isNoContent();
        http.get().uri("/api/users/me/permissions?envId={envId}", envId)
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approverEmail))
            .exchange()
            .expectStatus().isForbidden();
    }

    // ---------------------------------------------------------------- helpers

    private List<Permission> permissionsAt(String email, String scopeParam, UUID scopeId) {
        MyPermissionsResponse response = http.get()
            .uri("/api/users/me/permissions?" + scopeParam + "={scopeId}", scopeId)
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .exchange()
            .expectStatus().isOk()
            .expectBody(MyPermissionsResponse.class)
            .returnResult().getResponseBody();
        return response.getPermissions();
    }

    private static List<Permission> permissionsOfRole(RoleListResponse roles, String key) {
        return roles.getItems().stream()
            .filter(role -> key.equals(role.getKey()))
            .findFirst()
            .orElseThrow()
            .getPermissions();
    }
}
