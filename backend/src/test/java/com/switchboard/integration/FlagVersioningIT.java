package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.flag.FlagTargetingService;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpHeaders;
import reactor.test.StepVerifier;

/**
 * Write atomicity for one flag-env config change.
 *
 * <p>A config write is four statements - head, immutable snapshot, audit row,
 * environment state_version - and they are only meaningful together. Half of
 * them would be worse than none: a bumped head with no snapshot silently
 * rewrites history, a bumped state_version with no head write tells every SDK to
 * refetch a change that never happened.
 */
class FlagVersioningIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    @Autowired
    private FlagTargetingService targeting;

    @Test
    void aSuccessfulUpdateWritesHeadSnapshotAuditAndStateVersionTogether() {
        Workspace workspace = createWorkspace("versioning");
        FlagDetailResponse flag = createBooleanFlag(workspace, "together-flag");
        UUID envId = workspace.environmentId(ENV_KEY);
        Map<String, Object> scope = Map.of("flagId", flag.getId(), "envId", envId);
        long stateVersionBefore = stateVersion(envId);

        FlagEnvConfigResponse before = envConfig(flag, ENV_KEY);
        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new FlagEnvConfigUpdateRequest(true, before.getConfig())
                .expectedVersion(before.getVersion())
                .comment("turn it on"))
            .exchange()
            .expectStatus().isOk()
            .expectBody(FlagEnvConfigResponse.class)
            .value(updated -> {
                assertThat(updated.getVersion()).isEqualTo(2);
                assertThat(updated.getEnabled()).isTrue();
            });

        assertThat(headVersion(scope)).isEqualTo(2);
        assertThat(snapshotVersions(scope)).containsExactly(1, 2);
        assertThat(updateAudits(flag.getKey(), envId)).isEqualTo(1);
        assertThat(stateVersion(envId) - stateVersionBefore).isEqualTo(1);
    }

    @Test
    void aFailureAfterTheHeadWriteRollsBackTheWholeChange() {
        Workspace workspace = createWorkspace("rollback-atomicity");
        FlagDetailResponse flag = createBooleanFlag(workspace, "atomic-flag");
        UUID envId = workspace.environmentId(ENV_KEY);
        Map<String, Object> scope = Map.of("flagId", flag.getId(), "envId", envId);

        // Occupying v2 makes the snapshot insert fail AFTER the head has been rewritten,
        // which is the only way to prove the head write is not committed on its own.
        execute("""
            INSERT INTO flag_env_config_versions
                (flag_id, environment_id, version_number, enabled, kill_switch_active,
                 config, version_note, created_by)
            SELECT flag_id, environment_id, 2, enabled, kill_switch_active,
                   config, 'poison', 'poison-writer'
            FROM flag_env_configs
            WHERE flag_id = :flagId AND environment_id = :envId
            """, scope);

        long stateVersionBefore = stateVersion(envId);

        StepVerifier.create(targeting.updateConfig(
                workspace.projectId(), flag.getKey(), ENV_KEY,
                workspace.ownerId(), workspace.ownerEmail(),
                true, enabledConfig(flag), 1, "must roll back"))
            .expectError(DataIntegrityViolationException.class)
            .verify(DB_TIMEOUT);

        assertThat(headVersion(scope)).isEqualTo(1);
        assertThat(headEnabled(scope)).isFalse();
        // The only v2 row is still the pre-planted one: no orphan snapshot was left behind.
        assertThat(selectColumn("""
                SELECT created_by FROM flag_env_config_versions
                WHERE flag_id = :flagId AND environment_id = :envId AND version_number = 2
                """, String.class, scope)).containsExactly("poison-writer");
        assertThat(updateAudits(flag.getKey(), envId)).isZero();
        assertThat(stateVersion(envId)).isEqualTo(stateVersionBefore);
    }

    @Test
    void anUnknownVariationReferenceIsRejectedBeforeAnythingIsWritten() {
        Workspace workspace = createWorkspace("bad-variation");
        FlagDetailResponse flag = createBooleanFlag(workspace, "invalid-flag");
        UUID envId = workspace.environmentId(ENV_KEY);
        Map<String, Object> scope = Map.of("flagId", flag.getId(), "envId", envId);
        long stateVersionBefore = stateVersion(envId);

        FlagTargetingConfig config = envConfig(flag, ENV_KEY).getConfig();
        config.setDefaultVariationId(UUID.randomUUID());

        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new FlagEnvConfigUpdateRequest(true, config).expectedVersion(1))
            .exchange()
            .expectStatus().isBadRequest()
            .expectBody()
            .jsonPath("$.error").isEqualTo("VALIDATION_FAILED");

        assertThat(headVersion(scope)).isEqualTo(1);
        assertThat(headEnabled(scope)).isFalse();
        assertThat(snapshotVersions(scope)).containsExactly(1);
        assertThat(updateAudits(flag.getKey(), envId)).isZero();
        assertThat(stateVersion(envId)).isEqualTo(stateVersionBefore);
    }

    // ---------------------------------------------------------------- helpers

    private TargetingConfig enabledConfig(FlagDetailResponse flag) {
        UUID onId = variationId(flag, "true");
        UUID offId = variationId(flag, "false");
        return new TargetingConfig(
            List.of(), List.of(), RolloutOrVariation.ofVariation(onId), offId, onId);
    }

    private Integer headVersion(Map<String, Object> scope) {
        return selectOne("""
            SELECT version FROM flag_env_configs
            WHERE flag_id = :flagId AND environment_id = :envId
            """, Integer.class, scope);
    }

    private Boolean headEnabled(Map<String, Object> scope) {
        return selectOne("""
            SELECT enabled FROM flag_env_configs
            WHERE flag_id = :flagId AND environment_id = :envId
            """, Boolean.class, scope);
    }

    private List<Integer> snapshotVersions(Map<String, Object> scope) {
        return selectColumn("""
            SELECT version_number FROM flag_env_config_versions
            WHERE flag_id = :flagId AND environment_id = :envId
            ORDER BY version_number
            """, Integer.class, scope);
    }

    private Long updateAudits(String flagKey, UUID envId) {
        return selectOne("""
            SELECT count(*) FROM audit_entries
            WHERE flag_key = :flagKey AND environment_id = :envId AND action = 'UPDATE'
            """, Long.class, Map.of("flagKey", flagKey, "envId", envId));
    }
}
