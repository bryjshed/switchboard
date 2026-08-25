package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.ai.JobResult;
import com.switchboard.application.ai.RolloutMonitorService;
import com.switchboard.domain.ai.stats.TwoProportionZ;
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
 * The regression test for the defect that outranked the peeking problem.
 *
 * <p>The aggregation counts evaluation <em>events</em> as well as distinct subjects, and only the
 * subject counts are a proportion of anything. A server SDK evaluating a flag in a hot loop emits
 * hundreds of events for one user, so an event-denominated "rate" is a ratio of event counts. Handed
 * to a test that assumes independent Bernoulli trials it understates the variance by roughly the
 * average evaluations-per-subject and inflates the statistic by roughly its square root.
 *
 * <p>No sequential statistic fixes that. An anytime-valid test built on those counts is rigorously
 * testing the wrong null and will fire just as confidently, just as wrongly - which is why this test
 * matters more than the peeking one.
 *
 * <p>The fixture gives each arm 200 subjects evaluated 50 times each, with 20 of the control's
 * subjects erroring against 30 of the treatment's - a difference that is nowhere near significant at
 * n = 200 per arm. Every erroring subject errors on each of its evaluations, which is what a broken
 * code path in a hot loop actually looks like.
 *
 * <p>The test asserts both halves, in the same discipline as {@code PeekingTest}: the monitor must
 * find nothing, <em>and</em> the old event-denominated arithmetic over the very same rows must
 * clear its old threshold by a wide margin. Without the second assertion this would pass on a
 * monitor that had simply stopped working.
 */
class RepeatedEvaluationIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";
    private static final int SUBJECTS_PER_ARM = 200;
    private static final int EVALUATIONS_PER_SUBJECT = 50;
    /** 10% vs 15% of subjects erroring: a real gap, but nowhere near significant at n = 200. */
    private static final int CONTROL_ERRORING_SUBJECTS = 20;
    private static final int TREATMENT_ERRORING_SUBJECTS = 30;
    private static final Duration EPOCH_AGE = Duration.ofHours(6);

    @Autowired
    private RolloutMonitorService monitor;

    @Test
    @DisplayName("50 evaluations per subject do not inflate the evidence")
    void repeatedEvaluationsOfOneContextDoNotInflateEvidence() {
        Workspace workspace = createWorkspace("repeat");
        String flagKey = "chatty-flag";
        FlagDetailResponse flag = createStringFlag(workspace, flagKey, List.of("control", "treatment"));
        UUID controlId = variationId(flag, "control");
        UUID treatmentId = variationId(flag, "treatment");
        UUID environmentId = workspace.environmentId(ENV_KEY);

        rampTo5050(workspace, flagKey, controlId, treatmentId);
        backdateVersion(flag.getId(), environmentId, EPOCH_AGE);

        seedChattyArm(environmentId, flagKey, controlId, flagKey + "-ctl-",
            CONTROL_ERRORING_SUBJECTS);
        seedChattyArm(environmentId, flagKey, treatmentId, flagKey + "-trt-",
            TREATMENT_ERRORING_SUBJECTS);

        // Each arm: 200 subjects, 10,000 eval events. That 50x gap between the two denominators is
        // the whole point of the fixture.
        assertThat(subjectCount(environmentId, controlId)).isEqualTo(SUBJECTS_PER_ARM);
        assertThat(eventCount(environmentId, controlId))
            .isEqualTo((long) SUBJECTS_PER_ARM * EVALUATIONS_PER_SUBJECT);

        JobResult result = monitor.scan().block(DB_TIMEOUT);

        assertThat(result.itemsScanned()).as("the flag was measured, not skipped").isEqualTo(1);
        assertThat(result.findingsCreated())
            .as("a 20-vs-30 subject difference is not evidence, from %s", result)
            .isZero();
        assertThat(selectOne("SELECT count(*) FROM anomaly_findings WHERE environment_id = :e",
            Long.class, Map.of("e", environmentId)))
            .isZero();

        // The other half. Over the very same rows, the old event-denominated arithmetic clears the
        // old z > 3 threshold several times over - so the fixture genuinely exercises the defect,
        // and this test is not merely passing because the monitor stopped working.
        double subjectZ = TwoProportionZ.zScore(
            TREATMENT_ERRORING_SUBJECTS, SUBJECTS_PER_ARM,
            CONTROL_ERRORING_SUBJECTS, SUBJECTS_PER_ARM);
        double eventZ = TwoProportionZ.zScore(
            errorEvents(environmentId, flagKey + "-trt-"),
            eventCount(environmentId, treatmentId),
            errorEvents(environmentId, flagKey + "-ctl-"),
            eventCount(environmentId, controlId));

        assertThat(subjectZ).as("subjects: not significant").isLessThan(2.0);
        assertThat(eventZ).as("events: the inflation, ~%.1fx".formatted(eventZ / subjectZ))
            .isGreaterThan(3.0);
        assertThat(eventZ / subjectZ)
            .as("inflation is about sqrt(evaluations per subject) = %.1f",
                Math.sqrt(EVALUATIONS_PER_SUBJECT))
            .isCloseTo(Math.sqrt(EVALUATIONS_PER_SUBJECT), org.assertj.core.data.Offset.offset(1.5));
    }

    private void rampTo5050(Workspace workspace, String flagKey, UUID controlId, UUID treatmentId) {
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
    }

    /**
     * One arm: many evaluations per subject, and every erroring subject errors on EACH of its
     * evaluations - which is what a broken code path in a hot loop actually produces, and what
     * makes the event-denominated numerator inflate in step with the denominator.
     */
    private void seedChattyArm(
        UUID environmentId, String flagKey, UUID variationId, String prefix, int erroringSubjects) {
        execute("""
            INSERT INTO eval_events
                (environment_id, flag_key, context_key, variation_id, reason, occurred_at)
            SELECT :envId, :flagKey, :prefix || s::text, :variationId, 'ROLLOUT',
                   now() - interval '2 hours'
            FROM generate_series(1, :subjects) AS s,
                 generate_series(1, :evaluations) AS e
            """, Map.of(
            "envId", environmentId,
            "flagKey", flagKey,
            "prefix", prefix,
            "variationId", variationId,
            "subjects", SUBJECTS_PER_ARM,
            "evaluations", EVALUATIONS_PER_SUBJECT));

        execute("""
            INSERT INTO metric_events (environment_id, context_key, metric_key, value, occurred_at)
            SELECT :envId, :prefix || s::text, 'error', 1, now() - interval '2 hours'
            FROM generate_series(1, :errors) AS s,
                 generate_series(1, :evaluations) AS e
            """, Map.of(
            "envId", environmentId,
            "prefix", prefix,
            "errors", erroringSubjects,
            "evaluations", EVALUATIONS_PER_SUBJECT));
    }

    private void backdateVersion(UUID flagId, UUID environmentId, Duration age) {
        execute("""
            UPDATE flag_env_config_versions SET created_at = now() - :age::interval
            WHERE flag_id = :flagId AND environment_id = :envId AND version_number = 2
            """, Map.of(
            "flagId", flagId, "envId", environmentId, "age", age.toHours() + " hours"));
    }

    private long subjectCount(UUID environmentId, UUID variationId) {
        return selectOne("""
            SELECT count(DISTINCT context_key) FROM eval_events
            WHERE environment_id = :e AND variation_id = :v
            """, Long.class, Map.of("e", environmentId, "v", variationId));
    }

    private long errorEvents(UUID environmentId, String prefix) {
        return selectOne("""
            SELECT count(*) FROM metric_events
            WHERE environment_id = :e AND metric_key = 'error' AND context_key LIKE :p
            """, Long.class, Map.of("e", environmentId, "p", prefix + "%"));
    }

    private long eventCount(UUID environmentId, UUID variationId) {
        return selectOne("""
            SELECT count(*) FROM eval_events WHERE environment_id = :e AND variation_id = :v
            """, Long.class, Map.of("e", environmentId, "v", variationId));
    }
}
