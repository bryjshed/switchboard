package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.EvalEventBatch;
import com.switchboard.interfaces.rest.model.EvalEventItem;
import com.switchboard.interfaces.rest.model.EvalReason;
import com.switchboard.interfaces.rest.model.MetricEventBatch;
import com.switchboard.interfaces.rest.model.MetricEventItem;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * Ingested telemetry lands in the right monthly partition, and out-of-range
 * telemetry lands in the DEFAULT catch-all instead of being rejected.
 *
 * <p>The baseline migration covers four months back through twelve months ahead.
 * A partitioned table with no DEFAULT partition rejects any row outside those
 * bounds outright, which for a fire-and-forget 202 endpoint means events
 * disappear with nobody the wiser - a clock-skewed SDK would silently stop
 * reporting. This asserts the catch-all is doing its job.
 */
class EventIngestionPartitionIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";
    private static final DateTimeFormatter PARTITION_SUFFIX =
        DateTimeFormatter.ofPattern("yyyy_MM", Locale.ROOT);

    private Workspace workspace;
    private UUID environmentId;
    private String sdkKey;

    @BeforeEach
    void seedEnvironment() {
        workspace = createWorkspace("events");
        environmentId = workspace.environmentId(ENV_KEY);
        sdkKey = mintSdkKey(workspace, ENV_KEY);
    }

    @Test
    void evalEventsSplitBetweenTheCurrentMonthAndTheDefaultPartition() {
        createBooleanFlag(workspace, "telemetry-flag");
        String inRangeKey = "ctx-in-range-" + UUID.randomUUID();
        String outOfRangeKey = "ctx-out-of-range-" + UUID.randomUUID();

        http.post().uri("/api/events/eval")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .bodyValue(new EvalEventBatch(List.of(
                new EvalEventItem("telemetry-flag", inRangeKey, midCurrentMonth())
                    .reason(EvalReason.ROLLOUT),
                new EvalEventItem("telemetry-flag", outOfRangeKey, farFuture())
                    .reason(EvalReason.ROLLOUT))))
            .exchange()
            .expectStatus().isAccepted();

        assertThat(partitionOf("eval_events", inRangeKey))
            .isEqualTo("eval_events_" + currentMonthSuffix());
        assertThat(partitionOf("eval_events", outOfRangeKey)).isEqualTo("eval_events_default");
        assertThat(rowCount("eval_events")).isEqualTo(2);
    }

    @Test
    void metricEventsSplitBetweenTheCurrentMonthAndTheDefaultPartition() {
        String inRangeKey = "ctx-in-range-" + UUID.randomUUID();
        String outOfRangeKey = "ctx-out-of-range-" + UUID.randomUUID();

        http.post().uri("/api/events/metrics")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .bodyValue(new MetricEventBatch(List.of(
                new MetricEventItem(inRangeKey, "conversion", midCurrentMonth())
                    .value(BigDecimal.ONE),
                new MetricEventItem(outOfRangeKey, "conversion", farFuture())
                    .value(BigDecimal.ONE))))
            .exchange()
            .expectStatus().isAccepted();

        assertThat(partitionOf("metric_events", inRangeKey))
            .isEqualTo("metric_events_" + currentMonthSuffix());
        assertThat(partitionOf("metric_events", outOfRangeKey)).isEqualTo("metric_events_default");
        assertThat(rowCount("metric_events")).isEqualTo(2);
    }

    // ---------------------------------------------------------------- helpers

    /** Mid-month at noon UTC: safely inside the current partition whatever the hour. */
    private static Instant midCurrentMonth() {
        return YearMonth.now(ZoneOffset.UTC).atDay(15).atTime(12, 0).toInstant(ZoneOffset.UTC);
    }

    /** Five years out: past the twelve months the baseline migration provisions. */
    private static Instant farFuture() {
        return YearMonth.now(ZoneOffset.UTC).plusYears(5).atDay(15)
            .atTime(12, 0).toInstant(ZoneOffset.UTC);
    }

    private static String currentMonthSuffix() {
        return YearMonth.now(ZoneOffset.UTC).format(PARTITION_SUFFIX);
    }

    private String partitionOf(String table, String contextKey) {
        return selectOne(
            "SELECT tableoid::regclass::text FROM " + table
                + " WHERE environment_id = :envId AND context_key = :contextKey",
            String.class, Map.of("envId", environmentId, "contextKey", contextKey));
    }

    private long rowCount(String table) {
        return selectOne("SELECT count(*) FROM " + table + " WHERE environment_id = :envId",
            Long.class, Map.of("envId", environmentId));
    }
}
