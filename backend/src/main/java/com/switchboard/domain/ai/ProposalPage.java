package com.switchboard.domain.ai;

import java.util.List;

/** One keyset page of proposals plus the cursor for the next page. */
public record ProposalPage(List<AiProposal> items, String nextCursor) {
}
