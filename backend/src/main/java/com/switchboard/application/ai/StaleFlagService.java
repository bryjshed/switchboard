package com.switchboard.application.ai;

import com.switchboard.application.settings.OrgSettingsService;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.FlagAssistantPort;
import com.switchboard.domain.ai.FlagChangeDiff;
import com.switchboard.domain.ai.ProposalKind;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.ai.RetirementInput;
import com.switchboard.domain.ai.RolloutMetricsRepository;
import com.switchboard.domain.ai.StaleFlagCandidate;
import com.switchboard.domain.ai.StaleFlagEnv;
import com.switchboard.domain.flag.RolloutOrVariation;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * The stale sweep. A flag is a retirement candidate when nothing has touched any
 * of its environment heads for longer than the org's staleFlagWeeks AND it has
 * stopped making a decision - either every environment is off, or every
 * environment serves one fixed variation (a 100/0 rollout counts as fixed).
 * Each candidate gets one RETIREMENT draft with a checklist from the assistant.
 */
@Service
public class StaleFlagService {

    private static final Logger log = LoggerFactory.getLogger(StaleFlagService.class);

    private final RolloutMetricsRepository metrics;
    private final ProposalService proposals;
    private final FlagAssistantPort assistant;
    private final OrgSettingsService orgSettings;

    public StaleFlagService(
        RolloutMetricsRepository metrics,
        ProposalService proposals,
        FlagAssistantPort assistant,
        OrgSettingsService orgSettings) {
        this.metrics = metrics;
        this.proposals = proposals;
        this.assistant = assistant;
        this.orgSettings = orgSettings;
    }

    public Mono<JobResult> scan() {
        Instant now = Instant.now();
        return metrics.findStaleFlagCandidates()
            .concatMap(candidate -> examine(candidate, now)
                .onErrorResume(e -> {
                    log.warn("Stale sweep failed for {}: {}", candidate.flagKey(), e.toString());
                    return Mono.just(0);
                }))
            .reduce(new int[] {0, 0}, (acc, created) -> new int[] {acc[0] + 1, acc[1] + created})
            .map(acc -> new JobResult("stale-flag-scan", acc[0], acc[1],
                "one RETIREMENT draft per settled flag older than the org's staleFlagWeeks"));
    }

    private Mono<Integer> examine(StaleFlagCandidate candidate, Instant now) {
        if (candidate.lastChangedAt() == null || !isSettled(candidate)) {
            return Mono.just(0);
        }
        return orgSettings.get(candidate.orgId()).flatMap(settings -> {
            Duration age = Duration.between(candidate.lastChangedAt(), now);
            long weeks = age.toDays() / 7;
            if (weeks < settings.staleFlagWeeks()) {
                return Mono.just(0);
            }
            return proposals.draftExists(candidate.projectId(), null, candidate.flagKey(),
                    ProposalKind.RETIREMENT)
                .flatMap(exists -> exists ? Mono.just(0) : propose(candidate, (int) weeks));
        });
    }

    private Mono<Integer> propose(StaleFlagCandidate candidate, int weeks) {
        List<String> envKeys = candidate.envs().stream().map(StaleFlagEnv::envKey).toList();
        return assistant.draftRetirementChecklist(
                new RetirementInput(candidate.flagKey(), candidate.flagName(), weeks, envKeys))
            .flatMap(checklist -> proposals.insertDraft(new AiProposal(
                null, candidate.orgId(), candidate.projectId(), null,
                ProposalKind.RETIREMENT, null,
                new FlagChangeDiff(
                    ProposalKind.RETIREMENT, candidate.flagKey(), candidate.flagName(), null, null,
                    List.of(), List.of(), List.of(), null, checklist),
                "Unchanged for " + weeks + " weeks and no longer branching; safe to retire.",
                ProposalStatus.DRAFT, "switchboard-sweeper", null, null, null)))
            .thenReturn(1);
    }

    /** Settled = nothing is enabled, or nothing is still splitting traffic. */
    private static boolean isSettled(StaleFlagCandidate candidate) {
        boolean noneEnabled = candidate.envs().stream().noneMatch(StaleFlagEnv::enabled);
        if (noneEnabled) {
            return true;
        }
        return candidate.envs().stream().allMatch(env -> isFixed(env.config().fallthrough()));
    }

    private static boolean isFixed(RolloutOrVariation serve) {
        if (!serve.hasRollout()) {
            return true;
        }
        return serve.rollout().stream().filter(weight -> weight.weight() > 0).count() <= 1;
    }
}
