package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * Renaming, archiving and restoring an environment.
 *
 * <p>The property most of these exist to pin down: <b>archiving is not switching off</b>. An
 * archived environment is hidden and frozen against ordinary config edits, but it keeps serving
 * whatever is still pointed at it, and the kill switch keeps working. Getting that backwards in
 * either direction is bad - a silent outage one way, a change nobody can stop the other.
 */
class EnvironmentLifecycleIT extends IntegrationTestBase {

    @Test
    @DisplayName("renames the display name and leaves the key alone")
    void renamesName() {
        Workspace workspace = createWorkspace("env-rename");

        patch(workspace, workspace.environmentId("dev"), Map.of("name", "Dev (shared)"))
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.name").isEqualTo("Dev (shared)")
            .jsonPath("$.key").isEqualTo("dev");
    }

    @Test
    @DisplayName("the key is not renameable, because SDK keys and audit rows already refer to it")
    void keyIsImmutable() {
        // Sending a key is not an error - it is simply not a field, and the environment is
        // unchanged. Asserting that stops a future contract change from quietly making it one.
        Workspace workspace = createWorkspace("env-key-immutable");

        patch(workspace, workspace.environmentId("dev"), Map.of("key", "development"))
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.key").isEqualTo("dev");
    }

    @Test
    @DisplayName("archiving sets archived_at and restoring clears it")
    void archiveAndRestore() {
        Workspace workspace = createWorkspace("env-archive");
        UUID dev = workspace.environmentId("dev");

        patch(workspace, dev, Map.of("archived", true))
            .expectStatus().isOk()
            .expectBody().jsonPath("$.archivedAt").isNotEmpty();

        patch(workspace, dev, Map.of("archived", false))
            .expectStatus().isOk()
            .expectBody().jsonPath("$.archivedAt").doesNotExist();
    }

    @Test
    @DisplayName("an archived environment KEEPS SERVING evaluations")
    void archivedStillEvaluates() {
        // The whole reason this is an archive and not a delete. Somebody tidying the dashboard
        // must not take down an environment that still has SDKs pointed at it.
        Workspace workspace = createWorkspace("env-archived-serves");
        createBooleanFlag(workspace, "still-serving");
        String sdkKey = mintSdkKey(workspace, "dev");

        patch(workspace, workspace.environmentId("dev"), Map.of("archived", true))
            .expectStatus().isOk();

        http.post().uri("/api/eval/{key}", "still-serving")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .bodyValue(Map.of("context", Map.of("key", "u1"), "default", "fallback"))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.reason").isEqualTo("FLAG_OFF")
            .jsonPath("$.value").isEqualTo("false");
    }

    @Test
    @DisplayName("an archived environment refuses ordinary config writes")
    void archivedRefusesWrites() {
        Workspace workspace = createWorkspace("env-archived-frozen");
        var flag = createBooleanFlag(workspace, "frozen");
        // The body is built BEFORE archiving: serveRequest reads the current config, and the
        // point of the test is that the write is refused, not that reading one is.
        var body = serveRequest(flag, "dev", "true", null);
        patch(workspace, workspace.environmentId("dev"), Map.of("archived", true))
            .expectStatus().isOk();

        http.put().uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), "frozen", "dev")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(body)
            .exchange()
            .expectStatus().isEqualTo(409);
    }

    @Test
    @DisplayName("but the KILL SWITCH still works on an archived environment")
    void archivedStillAcceptsKillSwitch() {
        // It is still serving, so it must still be stoppable. Same reasoning that already lets
        // the kill switch bypass approval: an emergency path with preconditions is not one.
        Workspace workspace = createWorkspace("env-archived-kill");
        createBooleanFlag(workspace, "killable");
        patch(workspace, workspace.environmentId("dev"), Map.of("archived", true))
            .expectStatus().isOk();

        http.post().uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/kill-switch",
                workspace.projectId(), "killable", "dev")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("active", true, "reason", "archived but still serving"))
            .exchange()
            .expectStatus().isOk()
            .expectBody().jsonPath("$.killSwitchActive").isEqualTo(true);
    }

    @Test
    @DisplayName("the project's last active environment cannot be archived")
    void refusesArchivingTheLastOne() {
        // Otherwise the environment picker is empty and there is no way back through the UI.
        Workspace workspace = createWorkspace("env-last");
        patch(workspace, workspace.environmentId("dev"), Map.of("archived", true))
            .expectStatus().isOk();
        patch(workspace, workspace.environmentId("staging"), Map.of("archived", true))
            .expectStatus().isOk();

        patch(workspace, workspace.environmentId("production"), Map.of("archived", true))
            .expectStatus().isBadRequest();

        Long active = selectOne(
            "SELECT count(*) FROM environments WHERE project_id = :p AND archived_at IS NULL",
            Long.class, Map.of("p", workspace.projectId()));
        assertThat(active).isEqualTo(1L);
    }

    @Test
    @DisplayName("an archived environment keeps its key, so recreating it is a 409 that says so")
    void archivedKeyStaysReserved() {
        Workspace workspace = createWorkspace("env-key-reserved");
        patch(workspace, workspace.environmentId("dev"), Map.of("archived", true))
            .expectStatus().isOk();

        http.post().uri("/api/projects/{projectId}/environments", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("key", "dev", "name", "Dev again"))
            .exchange()
            .expectStatus().isEqualTo(409)
            .expectBody().jsonPath("$.message").value(
                message -> assertThat((String) message).contains("archived"));
    }

    @Test
    @DisplayName("a flag created while an environment is archived still gets a config there")
    void archivedEnvironmentsStillGetNewFlags() {
        // Otherwise restoring would hand back an environment where the flags created in the
        // meantime evaluate to SDK_DEFAULT - the exact defect the creation backfill fixed.
        Workspace workspace = createWorkspace("env-archived-seed");
        UUID dev = workspace.environmentId("dev");
        patch(workspace, dev, Map.of("archived", true)).expectStatus().isOk();

        createBooleanFlag(workspace, "born-during-archive");

        Long configs = selectOne("""
            SELECT count(*) FROM flag_env_configs c
            JOIN flags f ON f.id = c.flag_id
            WHERE f.key = 'born-during-archive' AND c.environment_id = :env
            """, Long.class, Map.of("env", dev));
        assertThat(configs).as("archived environments are still seeded").isEqualTo(1L);
    }

    @Test
    @DisplayName("the lifecycle is audited, including creation, which never used to be")
    void writesAuditRows() {
        Workspace workspace = createWorkspace("env-audit");
        UUID dev = workspace.environmentId("dev");
        patch(workspace, dev, Map.of("name", "Dev two")).expectStatus().isOk();
        patch(workspace, dev, Map.of("archived", true)).expectStatus().isOk();
        patch(workspace, dev, Map.of("archived", false)).expectStatus().isOk();

        http.post().uri("/api/projects/{projectId}/environments", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("key", "audited", "name", "Audited"))
            .exchange().expectStatus().isCreated();

        String actions = selectOne("""
            SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_entries
            WHERE project_id = :p AND action LIKE 'ENVIRONMENT%'
            """, String.class, Map.of("p", workspace.projectId()));
        assertThat(actions).isEqualTo(
            "ENVIRONMENT_ARCHIVE,ENVIRONMENT_CREATE,ENVIRONMENT_RENAME,ENVIRONMENT_RESTORE");
    }

    @Test
    @DisplayName("changing an environment needs MANAGE_ENVIRONMENTS")
    void requiresPermission() {
        Workspace workspace = createWorkspace("env-lifecycle-perm");
        String memberEmail = uniqueEmail("env-lifecycle-member");
        signIn(memberEmail);
        addOrgMember(workspace, memberEmail,
            com.switchboard.interfaces.rest.model.OrgRole.MEMBER);

        http.patch().uri("/api/environments/{envId}", workspace.environmentId("dev"))
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(memberEmail))
            .bodyValue(Map.of("archived", true))
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    @DisplayName("another org cannot touch these environments")
    void tenancyIsEnforced() {
        Workspace mine = createWorkspace("env-life-mine");
        Workspace theirs = createWorkspace("env-life-theirs");

        http.patch().uri("/api/environments/{envId}", mine.environmentId("dev"))
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .bodyValue(Map.of("name", "Yours now"))
            .exchange()
            .expectStatus().isForbidden();
    }

    private org.springframework.test.web.reactive.server.WebTestClient.ResponseSpec patch(
        Workspace workspace, UUID environmentId, Map<String, Object> body) {
        return http.patch().uri("/api/environments/{envId}", environmentId)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(body)
            .exchange();
    }
}
