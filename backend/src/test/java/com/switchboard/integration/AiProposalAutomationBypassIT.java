package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.ai.RolloutMonitorService;
import com.switchboard.application.settings.OrgSettingsService;
import com.switchboard.interfaces.rest.model.ApprovalSettingsResponse;
import com.switchboard.interfaces.rest.model.ApprovalSettingsUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.RolloutOrVariation;
import com.switchboard.interfaces.rest.model.WeightedVariation;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;

/**
 * The automation half of the approval gate, which is the decision this feature
 * actually turns on.
 *
 * <p>An automated healing rollback fires during an error spike and puts traffic
 * back on the baseline that was already live. Making it wait in a review queue
 * removes the reason to automate it, so {@code allowAutomationBypass} defaults to
 * TRUE and the rollback still lands immediately in a gated environment - the same
 * trade the kill switch already makes one column over. The write is still fully
 * audited, under the automation's name, and additionally recorded as
 * APPROVAL_BYPASS so "every write that skipped review" stays one query.
 *
 * <p>An org that wants no unreviewed write path at all turns the setting off, and
 * then the healing rollback parks like everything else.
 */
class AiProposalAutomationBypassIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";
    private static final String MONITOR = "switchboard-monitor";
    /** Above the monitor's 200-subject floor; one eval event per context, so these are subjects. */
    private static final int CONTROL_EVALS = 400;
    private static final int CONTROL_ERRORS = 8;
    private static final int TREATMENT_EVALS = 400;
    private static final int TREATMENT_ERRORS = 100;
    /** The evidence window runs from the allocation epoch, so it has to open before the events. */
    private static final Duration EPOCH_AGE = Duration.ofHours(6);

    @Autowired
    private RolloutMonitorService monitor;

    @Autowired
    private OrgSettingsService orgSettings;

    // ---------------------------------------------------------------- (d) default: bypass

    @Test
    void withTheDefaultBypassAutomatedHealingStillAppliesImmediately() {
        Workspace workspace = createWorkspace("bypass-on");
        enableAutoRollback(workspace);
        Rollout rollout = seedDegradedRollout(workspace, "payments-v2");

        ApprovalSettingsResponse settings = requireApprovalKeepingBypass(workspace);
        assertThat(settings.getRequireApproval()).isTrue();
        assertThat(settings.getAllowAutomationBypass()).isTrue();

        monitor.scan().block(DB_TIMEOUT);

        // The rollback landed: v1 create, v2 the ramp, v3 the healing rollback.
        assertThat(headVersion(rollout.flagId(), rollout.environmentId())).isEqualTo(3);
        assertThat(fallthroughVariation(rollout)).isEqualTo(rollout.controlId().toString());

        // Nothing was parked, and the finding says it healed.
        assertThat(changeRequestCount(workspace)).isZero();
        assertThat(findingStatus(rollout)).isEqualTo("AUTO_ROLLED_BACK");
        assertThat(proposalStatuses(workspace)).containsExactly("APPLIED");

        // Audited as the automation, twice over: the write itself...
        assertThat(auditCount(rollout, "AI_APPLY", MONITOR)).isEqualTo(1);
        // ...and an explicit record that the gate was bypassed.
        assertThat(auditCount(rollout, "APPROVAL_BYPASS", MONITOR)).isEqualTo(1);
        assertThat(selectOne("""
                SELECT reason FROM audit_entries
                WHERE environment_id = :envId AND action = 'APPROVAL_BYPASS'
                """, String.class, Map.of("envId", rollout.environmentId())))
            .contains("allowAutomationBypass");
    }

    // ---------------------------------------------------------------- (e) bypass off

    @Test
    void withTheBypassOffAutomatedHealingParksInTheReviewQueue() {
        Workspace workspace = createWorkspace("bypass-off");
        enableAutoRollback(workspace);
        Rollout rollout = seedDegradedRollout(workspace, "payments-v3");

        ApprovalSettingsResponse settings = setApprovalSettings(workspace, ENV_KEY,
            new ApprovalSettingsUpdateRequest()
                .requireApproval(true)
                .minApprovals(1)
                .allowAutomationBypass(false));
        assertThat(settings.getAllowAutomationBypass()).isFalse();

        monitor.scan().block(DB_TIMEOUT);

        // The flag is untouched: still the 50/50 ramp at v2.
        assertThat(headVersion(rollout.flagId(), rollout.environmentId())).isEqualTo(2);

        // The healing rollback is waiting for a human instead.
        UUID proposalId = selectOne(
            "SELECT id FROM ai_proposals WHERE project_id = :projectId",
            UUID.class, Map.of("projectId", workspace.projectId()));
        assertThat(proposalStatuses(workspace)).containsExactly("DRAFT");
        assertThat(selectOne("""
                SELECT status FROM change_requests WHERE ai_proposal_id = :id
                """, String.class, Map.of("id", proposalId)))
            .isEqualTo("PENDING");
        assertThat(selectOne("""
                SELECT requested_by FROM change_requests WHERE ai_proposal_id = :id
                """, String.class, Map.of("id", proposalId)))
            .isEqualTo(MONITOR);

        // Nothing bypassed anything, and the finding must not claim it healed.
        assertThat(auditCount(rollout, "APPROVAL_BYPASS", MONITOR)).isZero();
        assertThat(auditCount(rollout, "AI_APPLY", MONITOR)).isZero();
        assertThat(findingStatus(rollout)).isEqualTo("OPEN");
    }

    // ---------------------------------------------------------------- fixtures

    private record Rollout(
        UUID flagId, String flagKey, UUID environmentId, UUID controlId, UUID treatmentId) {
    }

    private void enableAutoRollback(Workspace workspace) {
        orgSettings.update(workspace.orgId(), null, true, null, null, null, workspace.ownerEmail())
            .block(DB_TIMEOUT);
    }

    /** Approval on, automation bypass left at its default. */
    private ApprovalSettingsResponse requireApprovalKeepingBypass(Workspace workspace) {
        return setApprovalSettings(workspace, ENV_KEY, new ApprovalSettingsUpdateRequest()
            .requireApproval(true)
            .minApprovals(1));
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

        // Backdate the version row that opened this allocation: the monitor measures from the
        // epoch, and seeded events at now-2h would otherwise all fall before it.
        execute("""
            UPDATE flag_env_config_versions SET created_at = now() - :age::interval
            WHERE flag_id = :flagId AND environment_id = :envId AND version_number = 2
            """, Map.of(
            "flagId", flag.getId(), "envId", environmentId,
            "age", EPOCH_AGE.toHours() + " hours"));

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

    private static Instant withinWindow() {
        return Instant.now().minus(Duration.ofHours(2));
    }

    // ---------------------------------------------------------------- queries

    private String fallthroughVariation(Rollout rollout) {
        return selectOne("""
            SELECT config #>> '{fallthrough,variationId}' FROM flag_env_configs
            WHERE flag_id = :flagId AND environment_id = :envId
            """, String.class,
            Map.of("flagId", rollout.flagId(), "envId", rollout.environmentId()));
    }

    private String findingStatus(Rollout rollout) {
        return selectOne("SELECT status FROM anomaly_findings WHERE environment_id = :envId",
            String.class, Map.of("envId", rollout.environmentId()));
    }

    private List<String> proposalStatuses(Workspace workspace) {
        return selectColumn(
            "SELECT status FROM ai_proposals WHERE project_id = :projectId ORDER BY created_at",
            String.class, Map.of("projectId", workspace.projectId()));
    }

    private long changeRequestCount(Workspace workspace) {
        return selectOne("SELECT count(*) FROM change_requests WHERE project_id = :projectId",
            Long.class, Map.of("projectId", workspace.projectId()));
    }

    private long auditCount(Rollout rollout, String action, String actor) {
        return selectOne("""
            SELECT count(*) FROM audit_entries
            WHERE environment_id = :envId AND action = :action AND actor = :actor
            """, Long.class,
            Map.of("envId", rollout.environmentId(), "action", action, "actor", actor));
    }
}
