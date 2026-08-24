package com.switchboard.application.ai;

import com.switchboard.application.settings.OrgSettings;
import com.switchboard.application.settings.OrgSettingsService;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.AnomalyFinding;
import com.switchboard.domain.ai.AnomalyFindingRepository;
import com.switchboard.domain.ai.AnomalyInput;
import com.switchboard.domain.ai.AnomalyStatus;
import com.switchboard.domain.ai.EnvChange;
import com.switchboard.domain.ai.FlagAssistantPort;
import com.switchboard.domain.ai.FlagChangeDiff;
import com.switchboard.domain.ai.ProposalKind;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.ai.RolloutCandidate;
import com.switchboard.domain.ai.RolloutMetricsRepository;
import com.switchboard.domain.ai.TargetingDraft;
import com.switchboard.domain.ai.ValueServe;
import com.switchboard.domain.ai.ValueWeight;
import com.switchboard.domain.ai.VariantAggregate;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.org.OrgRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * The healing / optimizing loop.
 *
 * <p>Every live rollout is measured over the last 48 hours and screened with a
 * two-proportion z-test against its highest-traffic variation. A variant whose
 * ERROR rate is significantly worse produces an anomaly finding plus a suggested
 * rollback to the baseline (auto-applied when the org opted in). A variant whose
 * CONVERSION rate is significantly better produces an optimization proposal that
 * ramps it to the next step of 25/50/75/100.
 *
 * <p>The scan is safe to run as often as you like: findings are deduplicated on
 * {@code envId:flagKey:variationId:metric:windowStartHour}, and a flag+env that
 * already has an open draft of the same kind is skipped.
 */
@Service
public class RolloutMonitorService {

    private static final Logger log = LoggerFactory.getLogger(RolloutMonitorService.class);

    private static final Duration WINDOW = Duration.ofHours(48);
    private static final long MIN_SAMPLES = 50;
    private static final double Z_THRESHOLD = 3.0;
    private static final String ACTOR = "switchboard-monitor";
    private static final String ERROR_METRIC = "error";
    private static final String CONVERSION_METRIC = "conversion";

    private final RolloutMetricsRepository metrics;
    private final AnomalyFindingRepository findings;
    private final ProposalService proposals;
    private final FlagAssistantPort assistant;
    private final OrgSettingsService orgSettings;
    private final OrgRepository orgs;
    private final NotificationWebhook webhook;

    @SuppressWarnings("checkstyle:ParameterNumber")
    public RolloutMonitorService(
        RolloutMetricsRepository metrics,
        AnomalyFindingRepository findings,
        ProposalService proposals,
        FlagAssistantPort assistant,
        OrgSettingsService orgSettings,
        OrgRepository orgs,
        NotificationWebhook webhook) {
        this.metrics = metrics;
        this.findings = findings;
        this.proposals = proposals;
        this.assistant = assistant;
        this.orgSettings = orgSettings;
        this.orgs = orgs;
        this.webhook = webhook;
    }

    public Mono<JobResult> scan() {
        Instant since = Instant.now().minus(WINDOW).truncatedTo(ChronoUnit.HOURS);
        return metrics.findRolloutCandidates()
            .filter(RolloutMonitorService::isLiveRollout)
            .concatMap(candidate -> examine(candidate, since)
                .onErrorResume(e -> {
                    log.warn("Rollout scan failed for {}/{}: {}",
                        candidate.flag().key(), candidate.envKey(), e.toString());
                    return Mono.just(0);
                }))
            .reduce(new int[] {0, 0}, (acc, created) -> new int[] {acc[0] + 1, acc[1] + created})
            .map(acc -> new JobResult("rollout-scan", acc[0], acc[1],
                "window=48h zThreshold=" + Z_THRESHOLD + " minSamples=" + MIN_SAMPLES));
    }

    /** Only heads that actually split traffic are worth measuring. */
    private static boolean isLiveRollout(RolloutCandidate candidate) {
        if (!candidate.enabled() || candidate.killSwitchActive()) {
            return false;
        }
        return splitsTraffic(candidate.config().fallthrough())
            || candidate.config().rules().stream().anyMatch(rule -> splitsTraffic(rule.serve()));
    }

    private static boolean splitsTraffic(RolloutOrVariation serve) {
        return serve.hasRollout()
            && serve.rollout().stream().filter(weight -> weight.weight() > 0).count() >= 2;
    }

    // ---------------------------------------------------------------- one flag-env

    private Mono<Integer> examine(RolloutCandidate candidate, Instant since) {
        return metrics.aggregate(candidate.environmentId(), candidate.flag().key(), since)
            .flatMap(aggregates -> {
                Optional<VariantAggregate> baseline = aggregates.stream()
                    .max(Comparator.comparingLong(VariantAggregate::evalCount))
                    .filter(agg -> agg.evalCount() >= MIN_SAMPLES);
                if (baseline.isEmpty()) {
                    return Mono.just(0);
                }
                return orgSettings.get(candidate.orgId())
                    .flatMap(settings -> judge(candidate, since, aggregates, baseline.get(), settings));
            });
    }

    private Mono<Integer> judge(
        RolloutCandidate candidate, Instant since, List<VariantAggregate> aggregates,
        VariantAggregate baseline, OrgSettings settings) {

        List<VariantAggregate> challengers = aggregates.stream()
            .filter(agg -> !agg.variationId().equals(baseline.variationId()))
            .filter(agg -> agg.evalCount() >= MIN_SAMPLES)
            .toList();

        Optional<VariantAggregate> degraded = challengers.stream()
            .filter(agg -> errorZ(agg, baseline) > Z_THRESHOLD)
            .max(Comparator.comparingDouble(agg -> errorZ(agg, baseline)));
        if (degraded.isPresent()) {
            return heal(candidate, since, degraded.get(), baseline, settings);
        }

        Optional<VariantAggregate> winner = challengers.stream()
            .filter(agg -> conversionZ(agg, baseline) > Z_THRESHOLD)
            .max(Comparator.comparingDouble(agg -> conversionZ(agg, baseline)));
        return winner
            .map(agg -> optimize(candidate, agg, baseline, settings))
            .orElse(Mono.just(0));
    }

    private static double errorZ(VariantAggregate variant, VariantAggregate baseline) {
        return TwoProportionZ.zScore(
            variant.errorCount(), variant.evalCount(), baseline.errorCount(), baseline.evalCount());
    }

    private static double conversionZ(VariantAggregate variant, VariantAggregate baseline) {
        return TwoProportionZ.zScore(
            variant.conversionCount(), variant.evalCount(),
            baseline.conversionCount(), baseline.evalCount());
    }

    // ---------------------------------------------------------------- healing

    private Mono<Integer> heal(
        RolloutCandidate candidate, Instant since, VariantAggregate variant,
        VariantAggregate baseline, OrgSettings settings) {

        Flag flag = candidate.flag();
        double zScore = errorZ(variant, baseline);
        String dedupeKey = String.join(":",
            candidate.environmentId().toString(), flag.key(), String.valueOf(variant.variationId()),
            ERROR_METRIC, String.valueOf(since.getEpochSecond() / 3600));

        AnomalyInput input = new AnomalyInput(
            flag.key(), candidate.envKey(),
            label(flag, variant.variationId()), label(flag, baseline.variationId()),
            ERROR_METRIC, baseline.errorRate(), variant.errorRate(), zScore,
            variant.evalCount(), baseline.evalCount());

        return assistant.summarizeAnomaly(input)
            .flatMap(summary -> findings.insertIfAbsent(new AnomalyFinding(
                        null, candidate.environmentId(), flag.key(), variant.variationId(),
                        ERROR_METRIC, baseline.errorRate(), variant.errorRate(), zScore,
                        summary, AnomalyStatus.OPEN, null, null),
                    dedupeKey)
                .flatMap(finding -> attachRemediation(candidate, baseline, finding, summary, settings))
                .defaultIfEmpty(0));
    }

    private Mono<Integer> attachRemediation(
        RolloutCandidate candidate, VariantAggregate baseline, AnomalyFinding finding,
        String summary, OrgSettings settings) {

        String baselineValue = value(candidate.flag(), baseline.variationId());
        if (baselineValue == null) {
            return Mono.just(1);
        }
        TargetingDraft draft = new TargetingDraft(
            null, null, ValueServe.ofValue(baselineValue), null, null);
        FlagChangeDiff diff = updateDiff(candidate, draft);

        return proposals.draftExists(
                candidate.projectId(), candidate.environmentId(), candidate.flag().key(),
                ProposalKind.FLAG_UPDATE)
            .flatMap(exists -> exists
                ? Mono.just(1)
                : proposals.insertDraft(proposal(candidate, diff, summary))
                    .flatMap(saved -> findings.setSuggestedProposal(finding.id(), saved.id())
                        .then(settings.autoRollbackEnabled()
                            ? autoApply(candidate, saved, summary)
                                .flatMap(applied -> applied
                                    ? findings.markAutoRolledBack(finding.id())
                                    : Mono.<Void>empty())
                            : Mono.<Void>empty())
                        .thenReturn(1)))
            .flatMap(created -> webhook.notify(
                    candidate.orgId(), "anomaly", candidate.flag().key(), candidate.envKey(), summary)
                .thenReturn(created));
    }

    // ---------------------------------------------------------------- optimizing

    private Mono<Integer> optimize(
        RolloutCandidate candidate, VariantAggregate winner, VariantAggregate baseline,
        OrgSettings settings) {

        RolloutOrVariation fallthrough = candidate.config().fallthrough();
        if (!fallthrough.hasRollout()) {
            return Mono.just(0);
        }
        Map<UUID, Integer> weights = new LinkedHashMap<>();
        fallthrough.rollout().forEach(weight -> weights.put(weight.variationId(), weight.weight()));
        Integer current = weights.get(winner.variationId());
        if (current == null) {
            return Mono.just(0);
        }
        int target = RolloutRamp.nextStep(current);
        if (target == 0) {
            return Mono.just(0);
        }

        Map<UUID, Integer> ramped = RolloutRamp.ramp(weights, winner.variationId(), target);
        List<ValueWeight> rollout = new ArrayList<>();
        for (Map.Entry<UUID, Integer> entry : ramped.entrySet()) {
            String value = value(candidate.flag(), entry.getKey());
            if (value == null) {
                return Mono.just(0);
            }
            rollout.add(new ValueWeight(value, entry.getValue()));
        }

        String rationale = String.format(
            Locale.ROOT,
            "Variation %s converts at %.1f%% over %d evaluations against %.1f%% for %s over %d "
                + "(z=%.2f). Ramping it from %d%% to %d%% of traffic.",
            label(candidate.flag(), winner.variationId()), winner.conversionRate() * 100,
            winner.evalCount(), baseline.conversionRate() * 100,
            label(candidate.flag(), baseline.variationId()), baseline.evalCount(),
            conversionZ(winner, baseline), current, target);

        TargetingDraft draft = new TargetingDraft(
            null, null, ValueServe.ofRollout(rollout), null, null);
        FlagChangeDiff diff = updateDiff(candidate, draft);

        return proposals.draftExists(
                candidate.projectId(), candidate.environmentId(), candidate.flag().key(),
                ProposalKind.FLAG_UPDATE)
            .flatMap(exists -> exists
                ? Mono.just(0)
                : proposals.insertDraft(proposal(candidate, diff, rationale))
                    .flatMap(saved -> settings.autoOptimizeEnabled()
                        ? autoApply(candidate, saved, rationale).thenReturn(1)
                        : Mono.just(1)))
            .flatMap(created -> webhook.notify(
                    candidate.orgId(), "optimization", candidate.flag().key(),
                    candidate.envKey(), rationale)
                .thenReturn(created));
    }

    // ---------------------------------------------------------------- shared

    /**
     * Background jobs borrow an org owner's identity; the audit actor stays the
     * job's name. The actor is marked as AUTOMATION, which is what lets a gated
     * environment let this write through under {@code allowAutomationBypass}.
     *
     * <p>Emits true when the write actually landed. In a gated environment that
     * turned the bypass off, it emits false: the apply was parked as a change
     * request, the flag is untouched, and the finding must NOT be marked
     * auto-rolled-back, because nothing has rolled back yet.
     */
    private Mono<Boolean> autoApply(RolloutCandidate candidate, AiProposal proposal, String reason) {
        return orgs.findAnyOwnerId(candidate.orgId())
            .flatMap(ownerId -> proposals.applyAsJob(
                proposal, ProposalActor.automation(ownerId, ACTOR), reason))
            .map(outcome -> {
                if (outcome instanceof ProposalOutcome.Pending pending) {
                    log.info("Auto-apply of proposal {} parked for review as change request {}",
                        proposal.id(), pending.request().id());
                    return false;
                }
                return true;
            })
            .doOnError(e -> log.warn("Auto-apply of proposal {} failed: {}", proposal.id(), e.toString()))
            .onErrorReturn(false)
            .defaultIfEmpty(false);
    }

    private static FlagChangeDiff updateDiff(RolloutCandidate candidate, TargetingDraft draft) {
        return new FlagChangeDiff(
            ProposalKind.FLAG_UPDATE, candidate.flag().key(), null, null, null,
            List.of(), List.of(),
            List.of(new EnvChange(candidate.envKey(), null, null, draft)),
            null, List.of());
    }

    private static AiProposal proposal(RolloutCandidate candidate, FlagChangeDiff diff, String rationale) {
        return new AiProposal(
            null, candidate.orgId(), candidate.projectId(), candidate.environmentId(),
            ProposalKind.FLAG_UPDATE, null, diff, rationale, ProposalStatus.DRAFT,
            ACTOR, null, null, null);
    }

    private static String value(Flag flag, UUID variationId) {
        Variation variation = flag.variationById(variationId);
        return variation == null ? null : variation.value();
    }

    private static String label(Flag flag, UUID variationId) {
        Variation variation = flag.variationById(variationId);
        if (variation == null) {
            return String.valueOf(variationId);
        }
        return variation.name() == null || variation.name().isBlank()
            ? variation.value()
            : variation.name() + " (" + variation.value() + ")";
    }
}
