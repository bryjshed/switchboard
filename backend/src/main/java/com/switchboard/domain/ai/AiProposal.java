package com.switchboard.domain.ai;

import java.time.Instant;
import java.util.UUID;

/** A persisted proposal row; {@code diff} is the JSONB column. */
public record AiProposal(
    UUID id,
    UUID orgId,
    UUID projectId,
    UUID environmentId,
    ProposalKind kind,
    String sourcePrompt,
    FlagChangeDiff diff,
    String rationale,
    ProposalStatus status,
    String createdBy,
    String appliedBy,
    Integer appliedVersion,
    Instant createdAt) {
}
