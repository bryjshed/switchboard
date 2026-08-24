package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.EvalContext;
import com.switchboard.interfaces.rest.model.EvalReason;
import com.switchboard.interfaces.rest.model.EvalResult;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.FlagVersionResponse;
import com.switchboard.interfaces.rest.model.RollbackRequest;
import com.switchboard.interfaces.rest.model.RolloutOrVariation;
import com.switchboard.interfaces.rest.model.SingleEvalRequest;
import com.switchboard.interfaces.rest.model.WeightedVariation;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * Rollback is an ordinary forward write, not an undo.
 *
 * <p>A flag is ramped through three versions and rolled back to v1. History must
 * still hold every version it ever held, v1 must read exactly as it did before
 * the rollback, and the rolled-back state must be what the SDK is served - the
 * proof that the head, the snapshot chain, and the evaluation snapshot cache all
 * moved together.
 */
class RollbackIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    @Test
    void rollingBackAppendsANewVersionAndChangesWhatIsServed() {
        Workspace workspace = createWorkspace("rollback");
        FlagDetailResponse flag = createBooleanFlag(workspace, "ramp-flag");
        UUID onId = variationId(flag, "true");
        UUID offId = variationId(flag, "false");
        String sdkKey = mintSdkKey(workspace, ENV_KEY);

        FlagVersionResponse originalV1 = version(workspace, flag.getKey(), 1);
        assertThat(originalV1.getEnabled()).isFalse();

        // v2: on, a quarter of traffic on the new behaviour.
        updateConfig(workspace, flag.getKey(), rollout(onId, 25, offId, 75), offId, onId, 1);
        // v3: half of traffic.
        updateConfig(workspace, flag.getKey(), rollout(onId, 50, offId, 50), offId, onId, 2);

        FlagEnvConfigResponse rolledBack = http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/rollback",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new RollbackRequest(1).reason("ramp went wrong"))
            .exchange()
            .expectStatus().isOk()
            .expectBody(FlagEnvConfigResponse.class)
            .returnResult().getResponseBody();

        // A NEW version, never a rewrite of v1.
        assertThat(rolledBack.getVersion()).isEqualTo(4);
        assertThat(rolledBack.getEnabled()).isFalse();
        assertThat(rolledBack.getConfig()).isEqualTo(originalV1.getConfig());

        assertThat(selectColumn("""
                SELECT version_number FROM flag_env_config_versions
                WHERE flag_id = :flagId AND environment_id = :envId
                ORDER BY version_number
                """, Integer.class,
            Map.of("flagId", flag.getId(), "envId", workspace.environmentId(ENV_KEY))))
            .containsExactly(1, 2, 3, 4);

        FlagVersionResponse v1AfterRollback = version(workspace, flag.getKey(), 1);
        assertThat(v1AfterRollback).isEqualTo(originalV1);

        FlagVersionResponse v4 = version(workspace, flag.getKey(), 4);
        assertThat(v4.getConfig()).isEqualTo(originalV1.getConfig());
        assertThat(v4.getVersionNote()).isEqualTo("rollback to v1");

        // What the SDK is served now reflects v1: the flag is off again.
        EvalResult result = http.post().uri("/api/eval/{flagKey}", flag.getKey())
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .bodyValue(new SingleEvalRequest(new EvalContext("user-1"))._default("unused"))
            .exchange()
            .expectStatus().isOk()
            .expectBody(EvalResult.class)
            .returnResult().getResponseBody();
        assertThat(result.getReason()).isEqualTo(EvalReason.FLAG_OFF);
        assertThat(result.getValue()).isEqualTo("false");
        assertThat(result.getFlagVersion()).isEqualTo(4);

        assertThat(auditActions(flag.getKey(), workspace.environmentId(ENV_KEY)))
            .containsExactly("UPDATE", "UPDATE", "ROLLBACK");
    }

    // ---------------------------------------------------------------- helpers

    private void updateConfig(
        Workspace workspace, String flagKey, RolloutOrVariation fallthrough,
        UUID offId, UUID defaultId, int expectedVersion) {
        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flagKey, ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new FlagEnvConfigUpdateRequest(
                true, new FlagTargetingConfig(fallthrough, offId, defaultId))
                .expectedVersion(expectedVersion)
                .comment("ramp"))
            .exchange()
            .expectStatus().isOk();
    }

    private FlagVersionResponse version(Workspace workspace, String flagKey, int versionNumber) {
        return http.get()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/versions/{versionNumber}",
                workspace.projectId(), flagKey, ENV_KEY, versionNumber)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(FlagVersionResponse.class)
            .returnResult().getResponseBody();
    }

    private static RolloutOrVariation rollout(UUID first, int firstWeight, UUID second, int secondWeight) {
        return new RolloutOrVariation()
            .addRolloutItem(new WeightedVariation(first, firstWeight))
            .addRolloutItem(new WeightedVariation(second, secondWeight));
    }

    private List<String> auditActions(String flagKey, UUID envId) {
        return selectColumn("""
            SELECT action FROM audit_entries
            WHERE flag_key = :flagKey AND environment_id = :envId
            ORDER BY created_at, version_to
            """, String.class, Map.of("flagKey", flagKey, "envId", envId));
    }
}
