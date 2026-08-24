package com.switchboard.domain.project;

import java.time.Instant;
import java.util.UUID;

/** An environment row, including its approval policy (see {@link ApprovalSettings}). */
public record Environment(
    UUID id,
    UUID projectId,
    String key,
    String name,
    long stateVersion,
    ApprovalSettings approvals,
    Instant createdAt) {
}
