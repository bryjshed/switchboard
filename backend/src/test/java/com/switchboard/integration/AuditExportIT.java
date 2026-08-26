package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * Audit export: complete, streamable, correctly quoted, and properly gated.
 *
 * <p>Retention is not exercised here beyond its default, because the default is what matters
 * most: it is OFF, and a test that quietly proved audit rows get deleted would be asserting
 * the opposite of the intended behaviour.
 */
class AuditExportIT extends IntegrationTestBase {

    private static final ObjectMapper JSON = new ObjectMapper();

    private String export(Workspace workspace, String query) {
        return http.get().uri("/api/orgs/{orgId}/audit/export" + query, workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(String.class)
            .returnResult().getResponseBody();
    }

    private static List<JsonNode> parseNdjson(String body) {
        // An empty export is a legitimate answer (WebTestClient hands back null for an empty
        // body), and it should surface as a failed assertion naming what was missing rather
        // than as an NPE in the helper.
        if (body == null || body.isBlank()) {
            return List.of();
        }
        return Arrays.stream(body.split("\n"))
            .filter(line -> !line.isBlank())
            .map(line -> {
                try {
                    return (JsonNode) JSON.readTree(line);
                } catch (Exception e) {
                    throw new AssertionError("not valid JSON on its own line: " + line, e);
                }
            })
            .toList();
    }

    @Test
    void exportsEveryAuditRowAsOneJsonObjectPerLine() {
        Workspace workspace = createWorkspace("export-ndjson");
        createBooleanFlag(workspace, "export-a");
        createBooleanFlag(workspace, "export-b");

        List<JsonNode> rows = parseNdjson(export(workspace, "?format=ndjson"));

        // Each line parsing independently is the property that makes this streamable at all.
        assertThat(rows).hasSizeGreaterThanOrEqualTo(2);
        assertThat(rows).allSatisfy(row -> {
            assertThat(row.path("id").asText()).isNotEmpty();
            assertThat(row.path("action").asText()).isNotEmpty();
            assertThat(row.path("createdAt").asText()).isNotEmpty();
        });
        assertThat(rows.stream().map(r -> r.path("flagKey").asText()).toList())
            .contains("export-a", "export-b");
    }

    @Test
    void rowsComeBackOldestFirst() {
        // The opposite of the paged feed, deliberately: an export is appended to a file or
        // replayed into a warehouse, where chronological order is the useful one.
        Workspace workspace = createWorkspace("export-order");
        createBooleanFlag(workspace, "export-first");
        createBooleanFlag(workspace, "export-second");

        List<JsonNode> rows = parseNdjson(export(workspace, ""));
        List<Instant> times = rows.stream().map(r -> Instant.parse(r.path("createdAt").asText())).toList();
        assertThat(times).isSorted();
    }

    @Test
    void sinceNarrowsTheWindow() {
        Workspace workspace = createWorkspace("export-since");
        createBooleanFlag(workspace, "export-old");

        // The boundary comes from the DATA, not from Instant.now(). created_at is written by
        // Postgres, which here is a container with its own clock; taking the boundary from the
        // JVM made this flaky - a few milliseconds of skew excluded the row the test was about
        // and the export came back empty. One microsecond past the newest existing row is
        // exact regardless of whose clock is ahead.
        List<JsonNode> before = parseNdjson(export(workspace, ""));
        assertThat(before).isNotEmpty();
        Instant boundary = before.stream()
            .map(r -> Instant.parse(r.path("createdAt").asText()))
            .max(Instant::compareTo).orElseThrow()
            .plusNanos(1_000);

        createBooleanFlag(workspace, "export-new");

        List<JsonNode> rows = parseNdjson(export(workspace, "?since=" + boundary));
        assertThat(rows.stream().map(r -> r.path("flagKey").asText()).toList())
            .contains("export-new")
            .doesNotContain("export-old");
    }

    @Test
    void anUnparseableSinceIsRejectedRatherThanIgnored() {
        // Quietly exporting everything when the caller asked for a window is how somebody ends
        // up with a 40 GB download they did not ask for.
        Workspace workspace = createWorkspace("export-badsince");
        http.get().uri("/api/orgs/{orgId}/audit/export?since=last-tuesday", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isBadRequest();
    }

    @Test
    void csvQuotesFreeTextThatWouldOtherwiseCorruptTheFile() {
        // `reason` is text a user typed. A comma shifts every later column; a newline corrupts
        // every later ROW. Both are pinned here because both are easy to not think about.
        Workspace workspace = createWorkspace("export-csv");
        var flag = createBooleanFlag(workspace, "export-csv-flag");
        http.post().uri("/api/projects/{p}/flags/{k}/environments/{e}/kill-switch",
                workspace.projectId(), "export-csv-flag", "production")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("active", true, "reason", "comma, \"quoted\", and\nnewline"))
            .exchange()
            .expectStatus().isOk();

        String csv = export(workspace, "?format=csv");
        assertThat(csv.split("\n")[0])
            .as("a fixed header, or the file is not machine-readable")
            .startsWith("id,createdAt,orgId");
        assertThat(csv).contains("\"comma, \"\"quoted\"\", and\nnewline\"");
        assertThat(flag.getKey()).isEqualTo("export-csv-flag");
    }

    @Test
    void theExportIsADownloadAndIsNotCached() {
        Workspace workspace = createWorkspace("export-headers");
        createBooleanFlag(workspace, "export-hdr");

        http.get().uri("/api/orgs/{orgId}/audit/export", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectHeader().contentTypeCompatibleWith("application/x-ndjson")
            .expectHeader().valueMatches(HttpHeaders.CONTENT_DISPOSITION, "attachment;.*\\.ndjson\"")
            .expectHeader().valueMatches(HttpHeaders.CACHE_CONTROL, ".*no-store.*");
    }

    @Test
    void anotherOrgCannotExportYourAudit() {
        Workspace mine = createWorkspace("export-mine");
        Workspace theirs = createWorkspace("export-theirs");
        createBooleanFlag(mine, "export-private");

        http.get().uri("/api/orgs/{orgId}/audit/export", mine.orgId())
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    void retentionIsOffByDefaultAndDeletesNothing() {
        // The most important assertion in this class. Audit rows are the record the governance
        // features exist to produce; a default that silently expired them would be destroying it.
        Workspace workspace = createWorkspace("export-retention");
        createBooleanFlag(workspace, "export-kept");
        int before = parseNdjson(export(workspace, "")).size();

        http.post().uri("/api/jobs/audit-retention")
            .header("X-Job-Token", "switchboard-integration-job-token")
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.job").isEqualTo("audit-retention")
            .jsonPath("$.detail").value(String.class, detail ->
                assertThat(detail).contains("keep forever"));

        assertThat(parseNdjson(export(workspace, "")).size())
            .as("a retention run with the default configuration must delete nothing")
            .isEqualTo(before);
    }

    @Test
    void theRetentionJobRefusesAWrongToken() {
        http.post().uri("/api/jobs/audit-retention")
            .header("X-Job-Token", "not-the-token")
            .exchange()
            .expectStatus().isForbidden();
    }
}
