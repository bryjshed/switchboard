package com.switchboard.domain.changerequest;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Persistence for change_requests and change_request_reviews. */
public interface ChangeRequestRepository {

    Mono<ChangeRequest> insert(ChangeRequest request);

    /** With reviews loaded. */
    Mono<ChangeRequest> findById(UUID changeRequestId);

    /**
     * SELECT ... FOR UPDATE on the request row. Every review runs behind this lock
     * so that concurrent approvals are serialised: without it two reviewers can
     * each commit a review, each count only their own under READ COMMITTED, and
     * neither cross a threshold of two.
     */
    Mono<ChangeRequest> lockById(UUID changeRequestId);

    /** Newest-first keyset page; every filter is optional. */
    Mono<ChangeRequestPage> list(
        UUID projectId, UUID environmentId, UUID flagId, ChangeRequestStatus status,
        String cursor, int limit);

    Flux<ChangeRequestReview> findReviews(UUID changeRequestId);

    /** One row per reviewer: a second decision from the same reviewer replaces the first. */
    Mono<Void> upsertReview(
        UUID changeRequestId, UUID reviewerUserId, String reviewer, ReviewDecision decision, String comment);

    /**
     * Compare-and-set on status; emits the number of rows moved. Zero means
     * somebody else already moved it, which is what makes apply idempotent.
     */
    Mono<Long> casStatus(UUID changeRequestId, ChangeRequestStatus from, ChangeRequestStatus to);

    Mono<Void> setAppliedVersion(UUID changeRequestId, Integer version);

    /**
     * How many of one AI proposal's change requests have NOT applied, ignoring
     * {@code excludingId}. A parked proposal can open one request per environment
     * and per kind, and it only becomes APPLIED once every one of them has landed,
     * so this count is what decides. A declined, withdrawn or stale sibling counts
     * too: it means the proposal was not fully applied, and leaving it DRAFT is
     * what makes it retryable.
     */
    Mono<Long> countNotAppliedByProposal(UUID aiProposalId, UUID excludingId);
}
