package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * User-defined metrics, and the two properties that matter most: an existing deployment's
 * behaviour is unchanged, and a newly created project is not silently left with none.
 */
class MetricDefinitionIT extends IntegrationTestBase {

    @Test
    @DisplayName("a new project is seeded with the two metrics the monitor used to hard-code")
    void newProjectsAreSeeded() {
        // Without this a project created after the migration would have no metrics at all and
        // the monitor would silently do nothing for it - indistinguishable from "no traffic
        // yet", which is the kind of gap nobody notices for a month.
        Workspace workspace = createWorkspace("metrics-seed");

        http.get().uri("/api/projects/{projectId}/metrics", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.length()").isEqualTo(2)
            .jsonPath("$[?(@.key=='error')].direction").isEqualTo("DECREASE_IS_BETTER")
            .jsonPath("$[?(@.key=='conversion')].direction").isEqualTo("INCREASE_IS_BETTER");
    }

    @Test
    @DisplayName("the seeded tau values match the constants the monitor used before")
    void seededTauMatchesTheOldConstants() {
        // switchboard.rollout-monitor.tau.error=0.01, tau.conversion=0.02. If these drifted, an
        // existing deployment's healing behaviour would change silently on upgrade.
        Workspace workspace = createWorkspace("metrics-tau");
        Double errorTau = selectOne(
            "SELECT tau FROM metric_definitions WHERE project_id = :p AND key = 'error'",
            Double.class, Map.of("p", workspace.projectId()));
        Double conversionTau = selectOne(
            "SELECT tau FROM metric_definitions WHERE project_id = :p AND key = 'conversion'",
            Double.class, Map.of("p", workspace.projectId()));
        assertThat(errorTau).isEqualTo(0.01);
        assertThat(conversionTau).isEqualTo(0.02);
    }

    @Test
    @DisplayName("defines a metric of your own")
    void createsCustomMetric() {
        Workspace workspace = createWorkspace("metrics-custom");

        http.post().uri("/api/projects/{projectId}/metrics", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of(
                "key", "refund",
                "name", "Refunds",
                "direction", "DECREASE_IS_BETTER",
                "tau", 0.005))
            .exchange()
            .expectStatus().isCreated()
            .expectBody()
            .jsonPath("$.key").isEqualTo("refund")
            .jsonPath("$.direction").isEqualTo("DECREASE_IS_BETTER")
            .jsonPath("$.autoAct").isEqualTo(true);
    }

    @Test
    @DisplayName("tau must be a proportion difference, strictly inside (0, 1)")
    void rejectsImpossibleTau() {
        // Zero would make every difference "worth reacting to"; one is not reachable by a
        // proportion difference at all.
        Workspace workspace = createWorkspace("metrics-tau-bad");
        for (double tau : new double[] {0d, 1d, -0.5d, 2d}) {
            http.post().uri("/api/projects/{projectId}/metrics", workspace.projectId())
                .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
                .bodyValue(Map.of("key", "bad" + Math.abs(tau), "name", "Bad",
                    "direction", "DECREASE_IS_BETTER", "tau", tau))
                .exchange()
                .expectStatus().isBadRequest();
        }
    }

    @Test
    @DisplayName("a duplicate key in the same project is a 409")
    void duplicateKeyConflicts() {
        Workspace workspace = createWorkspace("metrics-dupe");
        http.post().uri("/api/projects/{projectId}/metrics", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("key", "error", "name", "Errors again",
                "direction", "DECREASE_IS_BETTER", "tau", 0.01))
            .exchange()
            .expectStatus().isEqualTo(409);
    }

    @Test
    @DisplayName("an invalid key is refused before it can reach a metric event")
    void rejectsBadKey() {
        Workspace workspace = createWorkspace("metrics-badkey");
        http.post().uri("/api/projects/{projectId}/metrics", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("key", "Not A Key!", "name", "Nope",
                "direction", "DECREASE_IS_BETTER", "tau", 0.01))
            .exchange()
            .expectStatus().isBadRequest();
    }

    @Test
    @DisplayName("autoAct can be turned off, so a noisy metric is reported without moving traffic")
    void autoActIsOptional() {
        Workspace workspace = createWorkspace("metrics-noact");
        String id = http.post().uri("/api/projects/{projectId}/metrics", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("key", "latency-breach", "name", "Latency breaches",
                "direction", "DECREASE_IS_BETTER", "tau", 0.02, "autoAct", false))
            .exchange()
            .expectStatus().isCreated()
            .expectBody()
            .jsonPath("$.autoAct").isEqualTo(false)
            .returnResult().getResponseBody() != null
            ? metricId(workspace, "latency-breach") : null;
        assertThat(id).isNotNull();
    }

    @Test
    @DisplayName("updates leave the key alone - events already carry it")
    void updateCannotChangeTheKey() {
        Workspace workspace = createWorkspace("metrics-update");
        String id = metricId(workspace, "error");

        http.patch().uri("/api/metrics/{metricId}", id)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("name", "Renamed errors", "tau", 0.03))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.key").isEqualTo("error")
            .jsonPath("$.name").isEqualTo("Renamed errors")
            .jsonPath("$.tau").isEqualTo(0.03);
    }

    @Test
    @DisplayName("deleting a metric leaves its recorded events alone")
    void deleteKeepsTelemetry() {
        // Events are telemetry and a metric may be redefined later; deleting the definition
        // must not destroy the history that would make the new definition immediately useful.
        Workspace workspace = createWorkspace("metrics-delete");
        String sdkKey = mintSdkKey(workspace, "production");
        http.post().uri("/api/events/metrics")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .bodyValue(Map.of("events", List.of(Map.of(
                "contextKey", "u1", "metricKey", "error", "value", 1,
                "occurredAt", java.time.Instant.now().toString()))))
            .exchange().expectStatus().isAccepted();

        http.delete().uri("/api/metrics/{metricId}", metricId(workspace, "error"))
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange().expectStatus().isNoContent();

        Long events = selectOne(
            "SELECT count(*) FROM metric_events WHERE environment_id = :env",
            Long.class, Map.of("env", workspace.environmentId("production")));
        assertThat(events).as("telemetry survives the definition").isGreaterThan(0L);
    }

    @Test
    @DisplayName("another org cannot see or change these metrics")
    void tenancyIsEnforced() {
        Workspace mine = createWorkspace("metrics-mine");
        Workspace theirs = createWorkspace("metrics-theirs");

        http.get().uri("/api/projects/{projectId}/metrics", mine.projectId())
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .exchange().expectStatus().isForbidden();

        http.patch().uri("/api/metrics/{metricId}", metricId(mine, "error"))
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .bodyValue(Map.of("tau", 0.9))
            .exchange().expectStatus().isForbidden();
    }

    private String metricId(Workspace workspace, String key) {
        return selectOne(
            "SELECT id::text FROM metric_definitions WHERE project_id = :p AND key = :k",
            String.class, Map.of("p", workspace.projectId(), "k", key));
    }
}
