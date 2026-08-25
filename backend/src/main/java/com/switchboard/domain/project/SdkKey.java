package com.switchboard.domain.project;

import java.time.Instant;
import java.util.UUID;

public record SdkKey(
    UUID id,
    UUID environmentId,
    SdkKeyKind kind,
    String keyPrefix,
    String label,
    String createdBy,
    Instant createdAt,
    Instant revokedAt) {
}
