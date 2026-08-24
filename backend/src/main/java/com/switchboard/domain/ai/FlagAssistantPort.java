package com.switchboard.domain.ai;

import java.util.List;
import reactor.core.publisher.Mono;

/**
 * The only way the application layer talks to an LLM. Two adapters implement it:
 * a Claude-backed one when {@code switchboard.ai.anthropic-api-key} is set, and a
 * keyless no-op one that errors {@code AiUnavailableException} for drafting and
 * falls back to deterministic templates for the monitor's prose.
 *
 * <p><b>Tool-schema convention.</b> Everything nested under {@code envChanges}
 * names variations by their VALUE string, never by UUID. A FLAG_CREATE proposal
 * describes variations that do not exist yet, so no id could be produced; apply
 * time resolves value -&gt; UUID against the created or existing flag.
 */
public interface FlagAssistantPort {

    /** Turns a natural-language request into a typed diff, or errors when unavailable. */
    Mono<DraftResult> draftProposal(NlRequest request, ProjectSnapshot snapshot);

    /** One or two sentences describing a measured rollout degradation. */
    Mono<String> summarizeAnomaly(AnomalyInput input);

    /** Ordered, human-actionable steps for removing a stale flag. */
    Mono<List<String>> draftRetirementChecklist(RetirementInput input);
}
