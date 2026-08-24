package com.switchboard.infrastructure.ai;

import com.switchboard.domain.ai.AnomalyInput;
import com.switchboard.domain.ai.DraftResult;
import com.switchboard.domain.ai.FlagAssistantPort;
import com.switchboard.domain.ai.NlRequest;
import com.switchboard.domain.ai.ProjectSnapshot;
import com.switchboard.domain.ai.RetirementInput;
import com.switchboard.domain.common.AiUnavailableException;
import java.util.List;
import java.util.Locale;
import reactor.core.publisher.Mono;

/**
 * The keyless adapter. Natural-language drafting genuinely needs a model, so it
 * fails loudly with 503; the monitor's prose does not, so anomaly summaries and
 * retirement checklists fall back to deterministic templates. That keeps the
 * healing / optimizing / stale loops fully functional without an API key.
 */
public class NoopFlagAssistantAdapter implements FlagAssistantPort {

    @Override
    public Mono<DraftResult> draftProposal(NlRequest request, ProjectSnapshot snapshot) {
        return Mono.error(new AiUnavailableException("No AI provider configured"));
    }

    @Override
    public Mono<String> summarizeAnomaly(AnomalyInput input) {
        return Mono.just(String.format(
            Locale.ROOT,
            "Flag %s in %s: variation %s recorded a %.1f%% %s rate over %d evaluations, against "
                + "%.1f%% for the higher-traffic variation %s over %d (z=%.2f). Serving the "
                + "baseline to all traffic restores the known-good behaviour.",
            input.flagKey(), input.envKey(), input.variationLabel(),
            input.variantRate() * 100, input.metricKey(), input.variantSamples(),
            input.baselineRate() * 100, input.baselineLabel(), input.baselineSamples(),
            input.zScore()));
    }

    @Override
    public Mono<List<String>> draftRetirementChecklist(RetirementInput input) {
        return Mono.just(List.of(
            "Remove every reference to flag " + input.flagKey() + " from application code and SDK calls",
            "Delete the flag in Switchboard once no service reads it",
            "Notify the team that " + input.flagKey() + " is retired and its behaviour is now permanent"));
    }
}
