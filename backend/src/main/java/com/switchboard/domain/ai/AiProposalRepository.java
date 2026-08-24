package com.switchboard.domain.ai;

import java.util.UUID;
import reactor.core.publisher.Mono;

/** Persistence for ai_proposals. */
public interface AiProposalRepository {

    Mono<AiProposal> insert(AiProposal proposal);

    Mono<AiProposal> findById(UUID proposalId);

    /**
     * Compare-and-set on status: emits the number of rows moved out of DRAFT.
     * Zero means somebody else already applied, rejected, or expired it.
     */
    Mono<Long> casFromDraft(UUID proposalId, ProposalStatus toStatus, String actor);

    Mono<Void> setAppliedVersion(UUID proposalId, Integer version);

    /** Newest-first keyset page; {@code beforeCreatedAt}/{@code beforeId} null starts at the head. */
    Mono<ProposalPage> listByProject(
        UUID projectId, ProposalStatus status, String cursor, int limit);

    /** True when a DRAFT proposal of that kind already targets this flag in this environment. */
    Mono<Boolean> draftExists(UUID projectId, UUID environmentId, String flagKey, ProposalKind kind);
}
