package com.switchboard.domain.changerequest;

import java.time.Instant;
import java.util.UUID;

/** One row of {@code change_request_reviews}. */
public record ChangeRequestReview(
    UUID id,
    UUID changeRequestId,
    UUID reviewerUserId,
    String reviewer,
    ReviewDecision decision,
    String comment,
    Instant createdAt,
    Instant updatedAt) {
}
