package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.ai.RolloutMonitorService;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.RolloutOrVariation;
import com.switchboard.interfaces.rest.model.WeightedVariation;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;

/**
 * The allocation gate.
 *
 * <p>A rollout whose traffic does not arrive in the configured proportions has a broken randomizer,
 * and its arms are therefore not comparable populations. Any rate difference between them is
 * confounded, so acting on one means automatically rolling a flag back on the strength of an
 * artifact. The gate suppresses every comparison for that flag and raises a finding for a human
 * instead - there is nothing safe to automate about a broken randomizer.
 */
class SampleRatioMismatchIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";
    private static final Duration EPOCH_AGE = Duration.ofHours(6);

    @Autowired
    private RolloutMonitorService monitor;

    @Test
    @DisplayName("a broken split suppresses the degradation comparison and raises an SRM finding")
    void srmSuppressesTheDegradationComparison() {
        Workspace workspace = createWorkspace("srm");
        String flagKey = "skewed-flag";
        Arms arms = seed(workspace, flagKey);

        // 50/50 configured, 800/200 delivered - and the over-served arm is also erroring hard, so
        // without the gate this is exactly the shape that triggers an automated rollback.
        seedArm(arms.environmentId(), flagKey, arms.treatmentId(), flagKey + "-trt-", 800, 200, "ROLLOUT");
        seedArm(arms.environmentId(), flagKey, arms.controlId(), flagKey + "-ctl-", 200, 4, "ROLLOUT");

        // Not asserting itemsScanned: the scan covers every flag in the database, and the sibling
        // test's flag lives in the same one.
        monitor.scan().block(DB_TIMEOUT);

        List<String> kinds = selectColumn(
            "SELECT kind FROM anomaly_findings WHERE environment_id = :e",
            String.class, Map.of("e", arms.environmentId()));
        assertThat(kinds).containsExactly("SRM");

        assertThat(selectOne("""
            SELECT test_kind FROM anomaly_findings WHERE environment_id = :e
            """, String.class, Map.of("e", arms.environmentId())))
            .isEqualTo("DIRICHLET_MULTINOMIAL");
        assertThat(selectOne("""
            SELECT srm_p_value FROM anomaly_findings WHERE environment_id = :e
            """, Double.class, Map.of("e", arms.environmentId())))
            .isLessThan(0.001);
        // An SRM finding has no z-score, and a misleading 0.00 would read as "no effect". Asserted
        // as a SQL predicate because a Mono cannot carry a null through selectOne.
        assertThat(selectOne("""
            SELECT z_score IS NULL FROM anomaly_findings WHERE environment_id = :e
            """, Boolean.class, Map.of("e", arms.environmentId())))
            .isTrue();

        // No remediation: nothing about a broken randomizer is safe to automate.
        assertThat(selectOne("""
            SELECT count(*) FROM ai_proposals WHERE project_id = :p
            """, Long.class, Map.of("p", workspace.projectId())))
            .isZero();
    }

    @Test
    @DisplayName("rule-served traffic does not count against the rollout's allocation")
    void ruleServedTrafficDoesNotTriggerSrm() {
        Workspace workspace = createWorkspace("srm-rules");
        String flagKey = "targeted-flag";
        Arms arms = seed(workspace, flagKey);

        // The fallthrough rollout delivers a clean 300/300. On top of that, 600 more subjects reach
        // the treatment through a targeting rule - traffic that never went through the rollout at
        // all. Counting it against the configured weights would report a 900/300 mismatch, so any
        // flag with a targeting rule would be permanently suppressed.
        seedArm(arms.environmentId(), flagKey, arms.controlId(), flagKey + "-ctl-", 300, 6, "ROLLOUT");
        seedArm(arms.environmentId(), flagKey, arms.treatmentId(), flagKey + "-trt-", 300, 75, "ROLLOUT");
        seedArm(arms.environmentId(), flagKey, arms.treatmentId(), flagKey + "-rule-", 600, 150,
            "RULE_MATCH");

        monitor.scan().block(DB_TIMEOUT);

        List<String> kinds = selectColumn(
            "SELECT kind FROM anomaly_findings WHERE environment_id = :e",
            String.class, Map.of("e", arms.environmentId()));
        assertThat(kinds).as("no SRM finding").doesNotContain("SRM");
        // And the comparison it was gating still runs: the treatment really is erroring more.
        assertThat(kinds).contains("DEGRADATION");
    }

    // ---------------------------------------------------------------- fixtures

    private record Arms(UUID flagId, UUID environmentId, UUID controlId, UUID treatmentId) {
    }

    private Arms seed(Workspace workspace, String flagKey) {
        FlagDetailResponse flag = createStringFlag(workspace, flagKey, List.of("control", "treatment"));
        UUID controlId = variationId(flag, "control");
        UUID treatmentId = variationId(flag, "treatment");
        UUID environmentId = workspace.environmentId(ENV_KEY);

        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flagKey, ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new FlagEnvConfigUpdateRequest(
                true,
                new FlagTargetingConfig(
                    new RolloutOrVariation()
                        .addRolloutItem(new WeightedVariation(controlId, 50))
                        .addRolloutItem(new WeightedVariation(treatmentId, 50)),
                    controlId, treatmentId))
                .expectedVersion(1)
                .comment("ramp to 50%"))
            .exchange()
            .expectStatus().isOk();

        execute("""
            UPDATE flag_env_config_versions SET created_at = now() - :age::interval
            WHERE flag_id = :flagId AND environment_id = :envId AND version_number = 2
            """, Map.of(
            "flagId", flag.getId(), "envId", environmentId,
            "age", EPOCH_AGE.toHours() + " hours"));

        return new Arms(flag.getId(), environmentId, controlId, treatmentId);
    }

    private void seedArm(
        UUID environmentId, String flagKey, UUID variationId, String prefix,
        int subjects, int errors, String reason) {

        execute("""
            INSERT INTO eval_events
                (environment_id, flag_key, context_key, variation_id, reason, occurred_at)
            SELECT :envId, :flagKey, :prefix || s::text, :variationId, :reason,
                   now() - interval '2 hours'
            FROM generate_series(1, :subjects) AS s
            """, Map.of(
            "envId", environmentId, "flagKey", flagKey, "prefix", prefix,
            "variationId", variationId, "reason", reason, "subjects", subjects));

        if (errors > 0) {
            execute("""
                INSERT INTO metric_events (environment_id, context_key, metric_key, value, occurred_at)
                SELECT :envId, :prefix || s::text, 'error', 1, now() - interval '2 hours'
                FROM generate_series(1, :errors) AS s
                """, Map.of("envId", environmentId, "prefix", prefix, "errors", errors));
        }
    }
}
