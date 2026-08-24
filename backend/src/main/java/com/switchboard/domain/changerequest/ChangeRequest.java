package com.switchboard.domain.changerequest;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * One {@code change_requests} row with its reviews.
 *
 * <p>{@code minApprovals} and {@code allowSelfApproval} are snapshotted from the
 * environment when the request is opened, so retuning the policy mid-flight
 * cannot silently move the bar for a request already under review.
 *
 * <p>{@code aiProposalId} is set when an AI proposal apply was parked here rather
 * than written. It is what the review UI shows to say a proposal caused this, and
 * what carries the provenance into the audit trail once the request applies.
 */
public record ChangeRequest(
    UUID id,
    UUID orgId,
    UUID projectId,
    UUID environmentId,
    String environmentKey,
    UUID flagId,
    String flagKey,
    ChangeRequestKind kind,
    ChangeRequestPayload payload,
    int baseVersion,
    int minApprovals,
    boolean allowSelfApproval,
    ChangeRequestStatus status,
    UUID requestedByUserId,
    String requestedBy,
    String comment,
    Instant createdAt,
    Instant decidedAt,
    Integer appliedVersion,
    UUID aiProposalId,
    List<ChangeRequestReview> reviews) {

    public ChangeRequest {
        reviews = reviews == null ? List.of() : List.copyOf(reviews);
    }

    /** Reviewers whose APPROVE counts: everyone but the author, unless self-approval is allowed. */
    public List<String> effectiveApprovers() {
        return reviews.stream()
            .filter(review -> review.decision() == ReviewDecision.APPROVE)
            .filter(review -> allowSelfApproval || !review.reviewerUserId().equals(requestedByUserId))
            .map(ChangeRequestReview::reviewer)
            .toList();
    }

    public ChangeRequest withReviews(List<ChangeRequestReview> loaded) {
        return new ChangeRequest(
            id, orgId, projectId, environmentId, environmentKey, flagId, flagKey, kind, payload,
            baseVersion, minApprovals, allowSelfApproval, status, requestedByUserId, requestedBy,
            comment, createdAt, decidedAt, appliedVersion, aiProposalId, loaded);
    }
}
