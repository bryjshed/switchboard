package com.switchboard.interfaces.rest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.application.audit.AuditEntry;
import com.switchboard.application.audit.AuditQueryService;
import com.switchboard.interfaces.security.Principals;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Streaming audit export.
 *
 * <p>Deliberately does NOT implement a generated interface, for the reason the SSE and OFREP
 * controllers do not either: a generated method is fixed to one response type, and this answers
 * one operation as either NDJSON or CSV, streamed. The path, parameters and formats are still
 * declared in the OpenAPI document; only the binding is manual.
 *
 * <h2>NDJSON rather than a JSON array</h2>
 *
 * <p>One object per line. A JSON array would oblige a consumer to hold the whole export in
 * memory to parse it - which defeats the point, since the org that most needs an export is the
 * one whose audit table is too large to fit in a response body. NDJSON is line-oriented, so it
 * streams end to end: {@code curl ... | jq -c 'select(.action=="ROLLBACK")'} works on a table of
 * any size, and so does appending it to a warehouse load.
 *
 * <p>Rows are written as they arrive from the database. Nothing here collects the {@code Flux},
 * so memory is bounded by the buffer rather than by the size of the table.
 */
@RestController
public class AuditExportController {

    /** Fixed column order; a CSV whose columns move between exports is not machine-readable. */
    private static final String CSV_HEADER =
        "id,createdAt,orgId,projectId,environmentId,envKey,flagKey,action,actor,reason,versionFrom,versionTo";

    private final AuditQueryService audit;
    private final ObjectMapper json;

    /**
     * The APPLICATION's ObjectMapper, not a private one. A fresh {@code new ObjectMapper()} has
     * no JSR-310 module, so every {@code Instant} throws - and even once that is fixed, a second
     * mapper would be free to format timestamps differently from every other endpoint.
     */
    public AuditExportController(AuditQueryService audit, ObjectMapper json) {
        this.audit = audit;
        this.json = json;
    }

    @GetMapping(value = "/api/orgs/{orgId}/audit/export", produces = {
        "application/x-ndjson", "text/csv",
    })
    public Mono<ResponseEntity<Flux<String>>> exportOrgAudit(
        @PathVariable UUID orgId,
        @RequestParam(name = "format", required = false, defaultValue = "ndjson") String format,
        @RequestParam(name = "since", required = false) String since) {

        Instant from = parseSince(since);
        boolean csv = "csv".equalsIgnoreCase(format);

        return Principals.currentUser().map(user -> {
            Flux<AuditEntry> rows = audit.exportOrg(orgId, user.userId(), from);
            Flux<String> body = csv
                ? Flux.concat(Flux.just(CSV_HEADER + "\n"), rows.map(AuditExportController::toCsvLine))
                : rows.map(this::toNdjsonLine);

            return ResponseEntity.ok()
                .contentType(csv ? MediaType.parseMediaType("text/csv") : MediaType.parseMediaType("application/x-ndjson"))
                // An export is a download, and a stale one is worse than a slow one.
                .cacheControl(org.springframework.http.CacheControl.noStore())
                .header(HttpHeaders.CONTENT_DISPOSITION,
                    "attachment; filename=\"switchboard-audit-" + orgId + (csv ? ".csv\"" : ".ndjson\""))
                .body(body);
        });
    }

    /**
     * An unparseable {@code since} is rejected rather than silently ignored. Quietly exporting
     * everything when the caller asked for a window is the kind of helpfulness that produces a
     * 40 GB download and a confused operator.
     */
    private static Instant parseSince(String since) {
        if (since == null || since.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(since);
        } catch (DateTimeParseException e) {
            throw new com.switchboard.domain.common.ValidationException(
                "since must be an ISO-8601 instant, e.g. 2026-01-01T00:00:00Z");
        }
    }

    private String toNdjsonLine(AuditEntry entry) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", entry.id());
        row.put("createdAt", entry.createdAt());
        row.put("orgId", entry.orgId());
        row.put("projectId", entry.projectId());
        row.put("environmentId", entry.environmentId());
        row.put("envKey", entry.envKey());
        row.put("flagKey", entry.flagKey());
        row.put("action", entry.action());
        row.put("actor", entry.actor());
        row.put("reason", entry.reason());
        row.put("versionFrom", entry.versionFrom());
        row.put("versionTo", entry.versionTo());
        try {
            return json.writeValueAsString(row) + "\n";
        } catch (Exception e) {
            throw new IllegalStateException("Cannot serialise audit row " + entry.id(), e);
        }
    }

    private static String toCsvLine(AuditEntry entry) {
        return String.join(",",
            csv(entry.id()), csv(entry.createdAt()), csv(entry.orgId()), csv(entry.projectId()),
            csv(entry.environmentId()), csv(entry.envKey()), csv(entry.flagKey()), csv(entry.action()),
            csv(entry.actor()), csv(entry.reason()), csv(entry.versionFrom()), csv(entry.versionTo()))
            + "\n";
    }

    /**
     * RFC 4180 quoting. {@code reason} is free text a user typed, so it can contain commas,
     * quotes and newlines - all three of which would otherwise corrupt every subsequent column
     * of the file, and the last of which would corrupt every subsequent ROW.
     */
    private static String csv(Object value) {
        if (value == null) {
            return "";
        }
        String text = value.toString();
        if (text.indexOf(',') < 0 && text.indexOf('"') < 0 && text.indexOf('\n') < 0 && text.indexOf('\r') < 0) {
            return text;
        }
        return '"' + text.replace("\"", "\"\"") + '"';
    }
}
