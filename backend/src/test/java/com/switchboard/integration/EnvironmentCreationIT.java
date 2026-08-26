package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * Creating an environment, and the backfill that makes it usable.
 *
 * <p>The regression these exist for: creating an environment inserted only the environment row.
 * Creating a FLAG had always seeded a config in every existing environment, but not the reverse,
 * so a new environment began with no flag configurations at all - and every flag evaluated there
 * to the caller's default with reason {@code SDK_DEFAULT}, which is indistinguishable from a flag
 * that does not exist. Somebody adds an environment, points an SDK at it, and every flag in the
 * product silently serves its fallback.
 */
class EnvironmentCreationIT extends IntegrationTestBase {

    @Test
    @DisplayName("a new environment gets a config for every flag that already existed")
    void backfillsExistingFlags() {
        Workspace workspace = createWorkspace("env-backfill");
        FlagDetailResponse first = createBooleanFlag(workspace, "backfill-one");
        FlagDetailResponse second = createStringFlag(workspace, "backfill-two", List.of("a", "b"));

        UUID environmentId = createEnvironment(workspace, "staging-eu", "Staging (EU)");

        Long configs = selectOne(
            "SELECT count(*) FROM flag_env_configs WHERE environment_id = :env",
            Long.class, Map.of("env", environmentId));
        assertThat(configs).as("one per pre-existing flag").isEqualTo(2L);

        // And an immutable v1 snapshot each, exactly as flag creation writes.
        Long snapshots = selectOne(
            "SELECT count(*) FROM flag_env_config_versions WHERE environment_id = :env",
            Long.class, Map.of("env", environmentId));
        assertThat(snapshots).isEqualTo(2L);
        assertThat(first.getKey()).isNotBlank();
        assertThat(second.getKey()).isNotBlank();
    }

    @Test
    @DisplayName("a flag evaluates in the new environment instead of falling back to the default")
    void flagsEvaluateInTheNewEnvironment() {
        // The symptom the backfill fixes, asserted through the SDK surface rather than the
        // schema: SDK_DEFAULT here would mean the flag might as well not exist.
        Workspace workspace = createWorkspace("env-eval");
        createBooleanFlag(workspace, "eval-me");
        UUID environmentId = createEnvironment(workspace, "qa", "QA");
        // Minted from the id createEnvironment returned rather than through the Workspace
        // helper: Workspace snapshots its environments when it is built, so it does not know
        // about one created afterwards.
        String sdkKey = java.util.Objects.requireNonNull(
            http.post().uri("/api/environments/{envId}/sdk-keys", environmentId)
                .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
                .bodyValue(Map.of("label", "qa", "kind", "SERVER"))
                .exchange()
                .expectStatus().isCreated()
                .expectBody(com.switchboard.interfaces.rest.model.SdkKeyCreatedResponse.class)
                .returnResult().getResponseBody()).getKey();

        http.post().uri("/api/eval/{key}", "eval-me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .bodyValue(Map.of("context", Map.of("key", "u1"), "default", "fallback"))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.reason").isEqualTo("FLAG_OFF")
            .jsonPath("$.value").isEqualTo("false");
    }

    @Test
    @DisplayName("the seeded config is disabled, matching how a new flag starts everywhere else")
    void seededConfigIsOff() {
        // A backfilled flag must not arrive switched ON in a new environment - that would be a
        // silent release into an environment nobody has configured yet.
        Workspace workspace = createWorkspace("env-off");
        createBooleanFlag(workspace, "off-by-default");
        UUID environmentId = createEnvironment(workspace, "perf", "Perf");

        Boolean enabled = selectOne(
            "SELECT enabled FROM flag_env_configs WHERE environment_id = :env",
            Boolean.class, Map.of("env", environmentId));
        assertThat(enabled).isFalse();
    }

    @Test
    @DisplayName("a flag created afterwards still reaches every environment, including the new one")
    void laterFlagsReachTheNewEnvironment() {
        Workspace workspace = createWorkspace("env-later");
        createEnvironment(workspace, "staging-us", "Staging (US)");
        createBooleanFlag(workspace, "created-after");

        Long configs = selectOne("""
            SELECT count(*) FROM flag_env_configs c
            JOIN flags f ON f.id = c.flag_id
            WHERE f.key = 'created-after'
            """, Long.class, Map.of());
        assertThat(configs).as("three seeded environments plus the new one").isEqualTo(4L);
    }

    @Test
    @DisplayName("a duplicate key is refused and leaves nothing behind")
    void duplicateKeyIsRefused() {
        Workspace workspace = createWorkspace("env-dupe");
        createBooleanFlag(workspace, "dupe-flag");

        http.post().uri("/api/projects/{projectId}/environments", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("key", "production", "name", "Another production"))
            .exchange()
            .expectStatus().isEqualTo(409);

        // The transaction rolled back, so no orphan configs were left for a half-made
        // environment.
        Long environments = selectOne(
            "SELECT count(*) FROM environments WHERE project_id = :p",
            Long.class, Map.of("p", workspace.projectId()));
        assertThat(environments).isEqualTo(3L);
    }

    @Test
    @DisplayName("creating one needs MANAGE_ENVIRONMENTS")
    void requiresPermission() {
        Workspace workspace = createWorkspace("env-perm");
        String memberEmail = uniqueEmail("env-member");
        signIn(memberEmail);
        addOrgMember(workspace, memberEmail, com.switchboard.interfaces.rest.model.OrgRole.MEMBER);

        http.post().uri("/api/projects/{projectId}/environments", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(memberEmail))
            .bodyValue(Map.of("key", "sneaky", "name", "Sneaky"))
            .exchange()
            .expectStatus().isForbidden();
    }

    private UUID createEnvironment(Workspace workspace, String key, String name) {
        return UUID.fromString(java.util.Objects.requireNonNull(
            http.post().uri("/api/projects/{projectId}/environments", workspace.projectId())
                .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
                .bodyValue(Map.of("key", key, "name", name))
                .exchange()
                .expectStatus().isCreated()
                .expectBody(com.switchboard.interfaces.rest.model.EnvironmentResponse.class)
                .returnResult().getResponseBody()).getId().toString());
    }
}
