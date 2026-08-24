package com.switchboard.application.audit;

import java.time.Instant;
import java.util.UUID;

/** Audit feed read model; envKey is resolved from environment_id for responses. */
public record AuditEntry(
    UUID id,
    UUID orgId,
    UUID projectId,
    UUID environmentId,
    String envKey,
    String flagKey,
    String action,
    String actor,
    String reason,
    Integer versionFrom,
    Integer versionTo,
    Instant createdAt) {
}
