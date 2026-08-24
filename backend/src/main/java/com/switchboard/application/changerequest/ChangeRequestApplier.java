package com.switchboard.application.changerequest;

import com.switchboard.application.flag.EnvConfigResult;
import com.switchboard.application.flag.FlagTargetingService;
import com.switchboard.application.flag.WriteOrigin;
import com.switchboard.domain.ai.AiProposalRepository;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.changerequest.ChangeRequest;
import com.switchboard.domain.changerequest.ChangeRequestKind;
import com.switchboard.domain.changerequest.ChangeRequestRepository;
import com.switchboard.domain.changerequest.ChangeRequestStatus;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.flag.FlagRepository;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/**
 * Turns an APPROVED change request into a real flag write.
 *
 * <p>The write goes through {@link FlagTargetingService} - the same path a hand
 * edit takes - so an approved change is versioned, audited, streamed to SDKs and
 * rollback-able exactly like any other change. Nothing about the write path is
 * special-cased for approvals; only the audit action and the reason line differ.
 *
 * <p>Applying exactly once is guarded twice, the way {@code ProposalService}
 * guards an AI apply. A compare-and-set moves the row out of APPROVED, so only
 * one caller can proceed, and it shares a transaction with the write it
 * authorises, so a failure part-way leaves the request back in APPROVED. Behind
 * that, the version snapshot is stamped with the change request id and the
 * partial unique index on {@code created_from_change_request_id} turns a second
 * write into a database error even across two instances.
 *
 * <p>An approved request that an AI proposal opened also settles that proposal:
 * see {@link #settleProposal}. That is the second half of routing AI applies
 * through review - the proposal is only ever APPLIED because a human approved it.
 *
 * <p>Staleness is the other half. If the flag's head has moved past the version
 * the author edited against, the request goes STALE instead of clobbering the
 * newer work: the same refusal a direct write gets from a stale
 * {@code expectedVersion}, and the author has to rebase.
 */
@Service
public class ChangeRequestApplier {

    private final ChangeRequestRepository requests;
    private final FlagTargetingService targeting;
    private final FlagRepository flags;
    private final AiProposalRepository proposals;
    private final TransactionalOperator tx;

    public ChangeRequestApplier(
        ChangeRequestRepository requests,
        FlagTargetingService targeting,
        FlagRepository flags,
        AiProposalRepository proposals,
        TransactionalOperator tx) {
        this.requests = requests;
        this.targeting = targeting;
        this.flags = flags;
        this.proposals = proposals;
        this.tx = tx;
    }

    /** Applies an APPROVED request, or marks it STALE. Idempotent and race-safe. */
    public Mono<ChangeRequest> apply(ChangeRequest request) {
        if (request.status() != ChangeRequestStatus.APPROVED) {
            return Mono.error(new ConflictException(
                "Change request is " + request.status() + ", not APPROVED"));
        }
        return staleness(request)
            .flatMap(stale -> stale ? markStale(request.id()) : writeApproved(request));
    }

    /**
     * A kill switch is exempt: it deliberately ignores expectedVersion on the
     * direct path too, because the emergency stop must always be flippable.
     */
    private Mono<Boolean> staleness(ChangeRequest request) {
        if (request.kind() == ChangeRequestKind.KILL_SWITCH) {
            return Mono.just(false);
        }
        return flags.findHead(request.environmentId(), request.flagKey())
            .switchIfEmpty(Mono.error(new NotFoundException("Flag has no config in this environment")))
            .map(head -> head.config().version() != request.baseVersion());
    }

    private Mono<ChangeRequest> writeApproved(ChangeRequest request) {
        return requests.casStatus(request.id(), ChangeRequestStatus.APPROVED, ChangeRequestStatus.APPLIED)
            .flatMap(rows -> rows == 0
                ? Mono.<Integer>error(new ConflictException("Change request is no longer APPROVED"))
                : performWrite(request))
            .flatMap(version -> requests.setAppliedVersion(request.id(), version)
                .then(settleProposal(request, version)))
            .as(tx::transactional)
            // The head moved between the staleness read and the locked write.
            .onErrorResume(StaleWrite.class, e -> markStale(request.id()).then())
            .then(Mono.defer(() -> load(request.id())));
    }

    private Mono<Integer> performWrite(ChangeRequest request) {
        WriteOrigin origin = WriteOrigin.ofChangeRequest(request.id());
        String reason = reason(request);
        UUID projectId = request.projectId();
        String flagKey = request.flagKey();
        String envKey = request.environmentKey();
        UUID author = request.requestedByUserId();
        String authorEmail = request.requestedBy();

        Mono<EnvConfigResult> write = switch (request.kind()) {
            // expectedVersion = baseVersion: the head row is locked FOR UPDATE by
            // then, so this closes the window between the staleness read and the write.
            case TARGETING_UPDATE -> targeting.updateConfig(
                projectId, flagKey, envKey, author, authorEmail,
                Boolean.TRUE.equals(request.payload().enabled()), request.payload().config(),
                request.baseVersion(), reason, origin);
            case KILL_SWITCH -> targeting.setKillSwitch(
                projectId, flagKey, envKey, author, authorEmail,
                Boolean.TRUE.equals(request.payload().active()), reason, origin);
            case ROLLBACK -> targeting.rollback(
                projectId, flagKey, envKey, author, authorEmail,
                request.payload().toVersion(), reason, origin);
        };
        return write
            .onErrorMap(ConflictException.class, StaleWrite::new)
            .onErrorMap(DuplicateKeyException.class,
                e -> new ConflictException("Change request has already been applied"))
            .map(result -> result.head().version());
    }

    /**
     * Closes the loop back to the AI proposal that was parked here.
     *
     * <p>A parked proposal stays DRAFT while its change requests are under review,
     * because it has not been applied. It becomes APPLIED - with appliedVersion
     * set, exactly as a direct apply leaves it - once every request it opened has
     * landed. If any sibling was declined, withdrawn or went stale, the proposal
     * stays DRAFT: it was not fully applied, and DRAFT is the state from which it
     * can simply be applied again.
     *
     * <p>Runs inside the same transaction as the write it follows, so the
     * proposal's status can never disagree with what actually landed.
     */
    private Mono<Void> settleProposal(ChangeRequest request, int version) {
        UUID proposalId = request.aiProposalId();
        if (proposalId == null) {
            return Mono.empty();
        }
        return requests.countNotAppliedByProposal(proposalId, request.id())
            .flatMap(outstanding -> outstanding > 0
                ? Mono.<Void>empty()
                : proposals
                    .casFromDraft(proposalId, ProposalStatus.APPLIED, request.requestedBy())
                    .flatMap(rows -> rows == 0
                        ? Mono.<Void>empty()
                        : proposals.setAppliedVersion(proposalId, version)));
    }

    /**
     * The line that ends up in the audit row and the version note. It names the
     * reviewers whose approval let the change through, which is the whole point of
     * auditing an approval workflow.
     */
    private static String reason(ChangeRequest request) {
        List<String> approvers = request.effectiveApprovers();
        String who = approvers.isEmpty() ? "policy" : String.join(", ", approvers);
        String line = "Applied change request " + request.id() + ", approved by " + who;
        if (request.aiProposalId() != null) {
            line = line + "; from AI proposal " + request.aiProposalId();
        }
        return request.comment() == null || request.comment().isBlank()
            ? line
            : line + "; " + request.comment();
    }

    private Mono<ChangeRequest> markStale(UUID changeRequestId) {
        return requests.casStatus(changeRequestId, ChangeRequestStatus.APPROVED, ChangeRequestStatus.STALE)
            .then(Mono.defer(() -> load(changeRequestId)));
    }

    private Mono<ChangeRequest> load(UUID changeRequestId) {
        return requests.findById(changeRequestId)
            .switchIfEmpty(Mono.error(new NotFoundException("Change request not found")));
    }

    /**
     * Marker for "the flag moved under us". It has to be distinct from
     * ConflictException, because a lost compare-and-set raises one of those too
     * and must not be mistaken for staleness.
     */
    private static final class StaleWrite extends RuntimeException {

        private static final long serialVersionUID = 1L;

        StaleWrite(Throwable cause) {
            super(cause);
        }
    }
}
