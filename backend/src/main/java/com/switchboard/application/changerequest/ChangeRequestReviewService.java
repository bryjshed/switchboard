package com.switchboard.application.changerequest;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.changerequest.ChangeRequest;
import com.switchboard.domain.changerequest.ChangeRequestRepository;
import com.switchboard.domain.changerequest.ChangeRequestReview;
import com.switchboard.domain.changerequest.ChangeRequestStatus;
import com.switchboard.domain.changerequest.ReviewDecision;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.interfaces.security.AuthenticatedUser;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/**
 * Reviews on a change request, and the decision that follows from them.
 *
 * <p><b>Auto-apply on threshold.</b> The approval that meets {@code minApprovals}
 * applies the change in the same call. A separate "now apply it" step was
 * rejected: it leaves an APPROVED-but-unapplied limbo that somebody has to
 * remember to clear, and the reviewer who signed off has already made the
 * decision the second step would be asking for. {@link #applyApproved} still
 * exists, but only as an idempotent retry for a request that reached APPROVED and
 * whose write then failed - it can never apply something not yet approved.
 *
 * <p><b>Concurrency.</b> Every review runs behind {@code SELECT ... FOR UPDATE} on
 * the request row. Without that lock two reviewers can each commit a review and
 * each count only their own under READ COMMITTED, and a threshold of two is never
 * crossed. With it, reviews serialise, exactly one caller sees the count reach
 * the threshold, and only that caller's compare-and-set out of PENDING succeeds.
 */
@Service
public class ChangeRequestReviewService {

    private final ChangeRequestRepository requests;
    private final ChangeRequestApplier applier;
    private final OrgAccessService access;
    private final AuditWriter audit;
    private final TransactionalOperator tx;

    public ChangeRequestReviewService(
        ChangeRequestRepository requests,
        ChangeRequestApplier applier,
        OrgAccessService access,
        AuditWriter audit,
        TransactionalOperator tx) {
        this.requests = requests;
        this.applier = applier;
        this.access = access;
        this.audit = audit;
        this.tx = tx;
    }

    /** Records an approval and, if that meets the threshold, applies the change. */
    public Mono<ChangeRequest> approve(UUID changeRequestId, AuthenticatedUser user, String comment) {
        return load(changeRequestId)
            .flatMap(request -> requirePermission(request, user, Permission.APPROVE_CHANGES)
                .then(recordApproval(request, user, comment)))
            .flatMap(crossed -> Boolean.TRUE.equals(crossed)
                ? load(changeRequestId).flatMap(applier::apply)
                : load(changeRequestId));
    }

    /** One decline settles it: the request moves to DECLINED and cannot be revived. */
    public Mono<ChangeRequest> decline(UUID changeRequestId, AuthenticatedUser user, String comment) {
        return load(changeRequestId)
            .flatMap(request -> requirePermission(request, user, Permission.APPROVE_CHANGES)
                .then(requests.lockById(changeRequestId))
                .flatMap(locked -> requirePending(locked)
                    .then(requests.upsertReview(
                        changeRequestId, user.userId(), user.email(), ReviewDecision.DECLINE, comment))
                    .then(requests.casStatus(
                        changeRequestId, ChangeRequestStatus.PENDING, ChangeRequestStatus.DECLINED))
                    .then(audit.insert(
                        locked.orgId(), locked.projectId(), locked.environmentId(), locked.flagKey(),
                        "CHANGE_REQUEST_DECLINE", user.email(), comment, null, null, null)))
                .as(tx::transactional))
            .then(Mono.defer(() -> load(changeRequestId)));
    }

    /** The author, and only the author, can take their own request off the queue. */
    public Mono<ChangeRequest> withdraw(UUID changeRequestId, AuthenticatedUser user) {
        return load(changeRequestId)
            .flatMap(request -> requirePermission(request, user, Permission.FLAG_READ)
                .then(requests.lockById(changeRequestId))
                .flatMap(locked -> {
                    if (!locked.requestedByUserId().equals(user.userId())) {
                        return Mono.error(new ForbiddenException(
                            "Only the author can withdraw a change request"));
                    }
                    return requirePending(locked).then(requests.casStatus(
                        changeRequestId, ChangeRequestStatus.PENDING, ChangeRequestStatus.WITHDRAWN));
                })
                .as(tx::transactional))
            .then(Mono.defer(() -> load(changeRequestId)));
    }

    /**
     * Idempotent retry for an APPROVED request whose write did not land - a
     * transient database failure, or a permission that was missing at the moment
     * the threshold was met. It cannot apply anything that is not already
     * APPROVED, so it is not a way around review.
     */
    public Mono<ChangeRequest> applyApproved(UUID changeRequestId, AuthenticatedUser user) {
        return load(changeRequestId)
            .flatMap(request -> requirePermission(request, user, Permission.APPROVE_CHANGES)
                .then(applier.apply(request)));
    }

    // ---------------------------------------------------------------- plumbing

    /**
     * The whole review in one transaction behind the row lock: check, write the
     * reviewer's row, recount, and move the status when the bar is met. Emits
     * whether this call is the one that crossed the threshold.
     */
    private Mono<Boolean> recordApproval(ChangeRequest request, AuthenticatedUser user, String comment) {
        return requests.lockById(request.id())
            .switchIfEmpty(Mono.error(new NotFoundException("Change request not found")))
            .flatMap(locked -> requireSelfApprovalAllowed(locked, user)
                .then(requirePending(locked))
                .then(requests.upsertReview(
                    locked.id(), user.userId(), user.email(), ReviewDecision.APPROVE, comment))
                .then(requests.findReviews(locked.id()).collectList())
                .flatMap(reviews -> countApprovals(locked, reviews) >= locked.minApprovals()
                    ? requests.casStatus(
                        locked.id(), ChangeRequestStatus.PENDING, ChangeRequestStatus.APPROVED)
                        .map(rows -> rows == 1)
                    : Mono.just(false)))
            .as(tx::transactional);
    }

    /**
     * Self-approval is refused outright rather than silently discounted: a
     * reviewer who is told "recorded" but does not move the counter has no way to
     * tell that nothing happened.
     */
    private static Mono<Void> requireSelfApprovalAllowed(ChangeRequest request, AuthenticatedUser user) {
        if (!request.allowSelfApproval() && request.requestedByUserId().equals(user.userId())) {
            return Mono.error(new ForbiddenException(
                "Self-approval is not allowed in this environment"));
        }
        return Mono.empty();
    }

    private static long countApprovals(ChangeRequest request, List<ChangeRequestReview> reviews) {
        return reviews.stream()
            .filter(review -> review.decision() == ReviewDecision.APPROVE)
            .filter(review -> request.allowSelfApproval()
                || !review.reviewerUserId().equals(request.requestedByUserId()))
            .count();
    }

    private static Mono<Void> requirePending(ChangeRequest request) {
        return request.status() == ChangeRequestStatus.PENDING
            ? Mono.empty()
            : Mono.error(new ConflictException("Change request is " + request.status() + ", not PENDING"));
    }

    private Mono<Void> requirePermission(
        ChangeRequest request, AuthenticatedUser user, Permission permission) {
        return access.requireEnvironmentPermission(request.environmentId(), user.userId(), permission).then();
    }

    private Mono<ChangeRequest> load(UUID changeRequestId) {
        return requests.findById(changeRequestId)
            .switchIfEmpty(Mono.error(new NotFoundException("Change request not found")));
    }
}
