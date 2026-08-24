package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.ai.JobResult;
import com.switchboard.application.ai.RolloutMonitorService;
import com.switchboard.application.settings.OrgSettingsService;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.RolloutOrVariation;
import com.switchboard.interfaces.rest.model.WeightedVariation;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;

/**
 * The healing loop end to end, over real event rows.
 *
 * <p>A 50/50 rollout is fed telemetry in which the treatment errors at 25%
 * against the control's 1.8%. The monitor must notice (two-proportion z well
 * past its threshold of 3), record exactly one finding, and - when the org has
 * opted into auto-rollback - put the baseline back in front of all traffic as an
 * ordinary versioned write.
 *
 * <p>The rescan assertion is the important one: the scan is wired to a scheduler
 * AND to an external job trigger, so it will be run repeatedly over the same
 * window. Without the unique {@code dedupe_key} every run would file another
 * finding and another proposal for one incident.
 */
class RolloutScanIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";
    private static final int CONTROL_EVALS = 220;
    private static final int CONTROL_ERRORS = 4;
    private static final int TREATMENT_EVALS = 200;
    private static final int TREATMENT_ERRORS = 50;

    @Autowired
    private RolloutMonitorService monitor;

    @Autowired
    private OrgSettingsService orgSettings;

    @Test
    void aDegradedVariantIsFoundOnceAndOnlyOnce() {
        Workspace workspace = createWorkspace("monitor");
        Rollout rollout = seedDegradedRollout(workspace, "checkout-v2");

        JobResult first = monitor.scan().block(DB_TIMEOUT);
        assertThat(first.job()).isEqualTo("rollout-scan");

        assertThat(findingIds(rollout.environmentId())).hasSize(1);
        UUID findingId = findingIds(rollout.environmentId()).get(0);
        assertThat(findingColumn(findingId, "metric_key", String.class)).isEqualTo("error");
        assertThat(findingColumn(findingId, "variation_id", UUID.class))
            .isEqualTo(rollout.treatmentId());
        assertThat(findingColumn(findingId, "status", String.class)).isEqualTo("OPEN");
        assertThat(findingColumn(findingId, "z_score", BigDecimal.class).doubleValue())
            .isGreaterThan(3.0)
            .isLessThan(20.0);
        assertThat(findingColumn(findingId, "variant_rate", BigDecimal.class).doubleValue())
            .isCloseTo(0.25, org.assertj.core.data.Offset.offset(0.001));
        // A remediation proposal is attached, but left in DRAFT for a human.
        assertThat(findingColumn(findingId, "suggested_proposal_id", UUID.class)).isNotNull();
        assertThat(draftProposals(workspace)).isEqualTo(1);

        // Rescanning the same window must be a no-op, not a second incident.
        JobResult second = monitor.scan().block(DB_TIMEOUT);
        assertThat(second.findingsCreated()).isZero();
        assertThat(findingIds(rollout.environmentId())).containsExactly(findingId);
        assertThat(draftProposals(workspace)).isEqualTo(1);

        // Auto-rollback is off for this org, so the head is untouched.
        assertThat(headVersion(rollout)).isEqualTo(2);
    }

    @Test
    void withAutoRollbackOnTheFindingHealsTheFlag() {
        Workspace workspace = createWorkspace("healer");
        orgSettings.update(workspace.orgId(), null, true, null, null, null, workspace.ownerEmail())
            .block(DB_TIMEOUT);
        Rollout rollout = seedDegradedRollout(workspace, "payments-v2");

        monitor.scan().block(DB_TIMEOUT);

        List<UUID> findings = findingIds(rollout.environmentId());
        assertThat(findings).hasSize(1);
        assertThat(findingColumn(findings.get(0), "status", String.class))
            .isEqualTo("AUTO_ROLLED_BACK");

        // The head moved forward: v1 create, v2 the ramp, v3 the rollback.
        assertThat(headVersion(rollout)).isEqualTo(3);
        assertThat(selectOne("""
                SELECT config #>> '{fallthrough,variationId}' FROM flag_env_configs
                WHERE flag_id = :flagId AND environment_id = :envId
                """, String.class,
            Map.of("flagId", rollout.flagId(), "envId", rollout.environmentId())))
            .isEqualTo(rollout.controlId().toString());

        // Applied by the job, audited under the monitor's name, not a person's.
        assertThat(selectOne("""
                SELECT count(*) FROM audit_entries
                WHERE flag_key = :flagKey AND environment_id = :envId
                  AND action = 'AI_APPLY' AND actor = 'switchboard-monitor'
                """, Long.class,
            Map.of("flagKey", rollout.flagKey(), "envId", rollout.environmentId())))
            .isEqualTo(1);
    }

    // ---------------------------------------------------------------- fixtures

    private record Rollout(
        UUID flagId, String flagKey, UUID environmentId, UUID controlId, UUID treatmentId) {
    }

    /** A live 50/50 rollout whose treatment errors an order of magnitude more often. */
    private Rollout seedDegradedRollout(Workspace workspace, String flagKey) {
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

        String controlPrefix = flagKey + "-ctl-";
        String treatmentPrefix = flagKey + "-trt-";
        seedEvalEvents(environmentId, flagKey, controlId, controlPrefix, CONTROL_EVALS);
        seedEvalEvents(environmentId, flagKey, treatmentId, treatmentPrefix, TREATMENT_EVALS);
        seedMetricEvents(environmentId, controlPrefix, CONTROL_ERRORS);
        seedMetricEvents(environmentId, treatmentPrefix, TREATMENT_ERRORS);

        return new Rollout(flag.getId(), flagKey, environmentId, controlId, treatmentId);
    }

    private void seedEvalEvents(
        UUID environmentId, String flagKey, UUID variationId, String prefix, int count) {
        execute("""
            INSERT INTO eval_events
                (environment_id, flag_key, context_key, variation_id, reason, occurred_at)
            SELECT :envId, :flagKey, :prefix || g::text, :variationId, 'ROLLOUT', :occurredAt
            FROM generate_series(1, :count) AS g
            """, Map.of(
            "envId", environmentId,
            "flagKey", flagKey,
            "prefix", prefix,
            "variationId", variationId,
            "occurredAt", withinWindow(),
            "count", count));
    }

    private void seedMetricEvents(UUID environmentId, String prefix, int count) {
        if (count == 0) {
            return;
        }
        execute("""
            INSERT INTO metric_events (environment_id, context_key, metric_key, value, occurred_at)
            SELECT :envId, :prefix || g::text, 'error', 1, :occurredAt
            FROM generate_series(1, :count) AS g
            """, Map.of(
            "envId", environmentId,
            "prefix", prefix,
            "occurredAt", withinWindow(),
            "count", count));
    }

    /** Comfortably inside the monitor's 48-hour window and outside its truncation edge. */
    private static Instant withinWindow() {
        return Instant.now().minus(Duration.ofHours(2));
    }

    // ---------------------------------------------------------------- queries

    private List<UUID> findingIds(UUID environmentId) {
        return selectColumn("""
            SELECT id FROM anomaly_findings WHERE environment_id = :envId ORDER BY created_at
            """, UUID.class, Map.of("envId", environmentId));
    }

    private <T> T findingColumn(UUID findingId, String column, Class<T> type) {
        return selectOne("SELECT " + column + " FROM anomaly_findings WHERE id = :id",
            type, Map.of("id", findingId));
    }

    private long draftProposals(Workspace workspace) {
        return selectOne("""
            SELECT count(*) FROM ai_proposals WHERE project_id = :projectId AND status = 'DRAFT'
            """, Long.class, Map.of("projectId", workspace.projectId()));
    }

    private Integer headVersion(Rollout rollout) {
        return selectOne("""
            SELECT version FROM flag_env_configs
            WHERE flag_id = :flagId AND environment_id = :envId
            """, Integer.class,
            Map.of("flagId", rollout.flagId(), "envId", rollout.environmentId()));
    }
}
