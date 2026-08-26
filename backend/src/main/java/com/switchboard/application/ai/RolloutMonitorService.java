package com.switchboard.application.ai;

import com.switchboard.application.settings.OrgSettings;
import com.switchboard.application.settings.OrgSettingsService;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.AnomalyFinding;
import com.switchboard.domain.ai.AnomalyFindingRepository;
import com.switchboard.domain.ai.AnomalyInput;
import com.switchboard.domain.ai.AnomalyKind;
import com.switchboard.domain.ai.AnomalyStatistics;
import com.switchboard.domain.ai.AnomalyStatus;
import com.switchboard.domain.ai.AnomalyTestKind;
import com.switchboard.domain.ai.EnvChange;
import com.switchboard.domain.ai.EpochEvidenceRepository;
import com.switchboard.domain.ai.FlagAssistantPort;
import com.switchboard.domain.ai.FlagChangeDiff;
import com.switchboard.domain.ai.ProposalKind;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.ai.RolloutBaseline;
import com.switchboard.domain.ai.RolloutCandidate;
import com.switchboard.domain.metric.MetricDefinition;
import com.switchboard.domain.metric.MetricDefinitionRepository;
import com.switchboard.domain.ai.RolloutMetricsRepository;
import com.switchboard.domain.ai.RolloutRamp;
import com.switchboard.domain.ai.TargetingDraft;
import com.switchboard.domain.ai.ValueServe;
import com.switchboard.domain.ai.ValueWeight;
import com.switchboard.domain.ai.VariantAggregate;
import com.switchboard.domain.ai.stats.EBenjaminiHochberg;
import com.switchboard.domain.ai.stats.MixtureSequentialTest;
import com.switchboard.domain.ai.stats.SampleRatioMismatch;
import com.switchboard.domain.ai.stats.TwoProportionZ;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.flag.WeightedVariation;
import com.switchboard.domain.org.OrgRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * The healing / optimizing loop.
 *
 * <p>Every live rollout is measured from the start of its current allocation epoch and screened
 * with an anytime-valid mixture SPRT against the variation the <em>configuration</em> names as the
 * baseline. A challenger doing significantly worse on the error metric produces an anomaly finding
 * plus a suggested rollback (auto-applied when the org opted in); one doing significantly better on
 * conversion produces a proposal ramping it to the next step of 25/50/75/100.
 *
 * <h2>The property that makes this safe to schedule</h2>
 *
 * <p><b>The scan interval does not appear in any decision.</b> Run it every minute or once a day:
 * the error guarantees are identical, because the statistic is valid at every stopping time rather
 * than at one pre-committed sample size. The predecessor ran a fixed-horizon z-test hourly, which
 * meant more frequent scanning bought more false rollbacks, and nothing in the code said so.
 *
 * <h2>Two phases, and why</h2>
 *
 * <p>The scan measures <em>everything</em>, then decides. That shape is forced by the multiplicity
 * correction: e-BH needs the whole family of hypotheses in hand, and the family spans every
 * rolling-out flag in the environment. Deciding one flag at a time - as the predecessor did, taking
 * the maximum z across challengers and testing only that one - is a maximum of dependent statistics
 * judged against a single-hypothesis threshold.
 *
 * <h2>Gates, in order</h2>
 *
 * <ol>
 *   <li>The flag must actually split traffic, and have an epoch.
 *   <li>Each arm needs {@code min-subjects} distinct subjects - subjects, not evaluation events.
 *   <li>The sample-ratio-mismatch gate must pass. If it fails, every comparison for that flag is
 *       suppressed for the rest of the epoch and an SRM finding is raised for a human instead.
 *   <li>e-BH across the environment's family, at the direction's alpha.
 * </ol>
 *
 * <p>Findings dedupe on {@code envId:flagKey:variationId:metric:epochStart}, so one hypothesis
 * yields one finding per epoch however often the scan runs.
 */
@Service
public class RolloutMonitorService {

    private static final Logger log = LoggerFactory.getLogger(RolloutMonitorService.class);

    private static final String ACTOR = "switchboard-monitor";
    private static final String SRM_METRIC = "allocation";

    private final RolloutMetricsRepository metrics;
    private final AnomalyFindingRepository findings;
    private final EpochEvidenceRepository evidence;
    private final ProposalService proposals;
    private final FlagAssistantPort assistant;
    private final OrgSettingsService orgSettings;
    private final OrgRepository orgs;
    private final NotificationWebhook webhook;
    private final MetricDefinitionRepository definitions;
    private final RolloutMonitorProperties properties;

    @SuppressWarnings("checkstyle:ParameterNumber")
    public RolloutMonitorService(
        RolloutMetricsRepository metrics,
        AnomalyFindingRepository findings,
        EpochEvidenceRepository evidence,
        ProposalService proposals,
        FlagAssistantPort assistant,
        OrgSettingsService orgSettings,
        OrgRepository orgs,
        NotificationWebhook webhook,
        MetricDefinitionRepository definitions,
        RolloutMonitorProperties properties) {
        this.metrics = metrics;
        this.findings = findings;
        this.evidence = evidence;
        this.proposals = proposals;
        this.assistant = assistant;
        this.orgSettings = orgSettings;
        this.orgs = orgs;
        this.webhook = webhook;
        this.definitions = definitions;
        this.properties = properties;
    }

    public Mono<JobResult> scan() {
        if (!properties.isEnabled()) {
            return Mono.just(new JobResult("rollout-scan", 0, 0, "disabled"));
        }
        Instant now = Instant.now();
        return metrics.findRolloutCandidates()
            .filter(RolloutMonitorService::isLiveRollout)
            // flatMapSequential, NOT concatMap: measuring a candidate is one expensive
            // aggregation over the partitioned event tables (2.0-5.6 s at 2.4M events - see
            // docs/PERFORMANCE.md), and concatMap ran them strictly one after another, so a
            // scan cost the SUM. flatMapSequential runs `scanConcurrency` at a time while
            // still emitting IN ORDER, which matters because decide() indexes e-BH's
            // survives[] back against family order and breaks ties on it: an unordered
            // flatMap would leave the decisions identical but the reported ranks
            // non-deterministic between runs. Concurrency is bounded because the work is
            // database-bound, and an unbounded fan-out would simply move the queue.
            .flatMapSequential(candidate -> measure(candidate, now)
                .onErrorResume(e -> {
                    log.warn("Rollout scan failed for {}/{}: {}",
                        candidate.flag().key(), candidate.envKey(), e.toString());
                    return Mono.empty();
                }), properties.getScanConcurrency())
            .collectList()
            .flatMap(this::decide);
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

    // ---------------------------------------------------------------- phase one: measure

    /**
     * Measures one flag-env over its epoch and turns it into hypotheses. Takes no action and
     * writes nothing except the e-process supremum, which has to be recorded before the family can
     * be assembled.
     */
    private Mono<RolloutEvidence> measure(RolloutCandidate candidate, Instant now) {
        Instant epochStart = candidate.epochStartedAt();
        if (epochStart == null) {
            // No version history for a head that exists. Cannot establish an origin, so cannot
            // make an anytime-valid claim - decline to measure rather than guess a window.
            return Mono.empty();
        }
        Instant floor = now.minus(properties.getMaxLookback());
        boolean truncated = epochStart.isBefore(floor);
        Instant since = truncated ? floor : epochStart;

        Optional<UUID> baselineId = RolloutBaseline.pick(candidate.config());
        if (baselineId.isEmpty()) {
            return Mono.empty();
        }

        return metrics.aggregate(candidate.environmentId(), candidate.flag().key(), since)
            .flatMap(aggregates -> {
                Optional<VariantAggregate> baseline = aggregates.stream()
                    .filter(agg -> baselineId.get().equals(agg.variationId()))
                    .findFirst()
                    .filter(agg -> agg.subjectCount() >= properties.getMinSubjects());
                if (baseline.isEmpty()) {
                    return Mono.empty();
                }
                // Only metrics the project has defined, and only those it allows the monitor to
                // act on. A project with none defined produces no hypotheses at all, which is
                // correct: nobody has said what "worse" means for it.
                return definitions.findByProject(candidate.projectId())
                    .filter(MetricDefinition::autoAct)
                    .collectList()
                    .flatMap(defined -> defined.isEmpty()
                        ? Mono.empty()
                        : assemble(candidate, since, truncated, aggregates, baseline.get(), defined));
            });
    }

    private Mono<RolloutEvidence> assemble(
        RolloutCandidate candidate, Instant since, boolean truncated,
        List<VariantAggregate> aggregates, VariantAggregate baseline,
        List<MetricDefinition> definitions) {

        double srmLogE = sampleRatioLogEValue(candidate, aggregates);
        boolean srmFailed = srmLogE >= -Math.log(properties.getAlpha().getSrm());
        if (srmFailed) {
            // Randomization is broken. Every rate comparison on these arms is confounded, so none
            // of them join a family - suppression is the entire point of the gate.
            return Mono.just(new RolloutEvidence(
                candidate, since, truncated, aggregates, baseline, true, srmLogE, List.of()));
        }

        List<VariantAggregate> challengers = aggregates.stream()
            .filter(agg -> !agg.variationId().equals(baseline.variationId()))
            .filter(agg -> agg.subjectCount() >= properties.getMinSubjects())
            .toList();

        RolloutEvidence shell = new RolloutEvidence(
            candidate, since, truncated, aggregates, baseline, false, srmLogE, List.of());

        /*
         * EVERY defined metric, in BOTH directions.
         *
         * This used to be exactly two comparisons: 'error' tested only for degradation and
         * 'conversion' tested only for improvement. That asymmetry was never stated as a
         * decision and hid a real blind spot - a variation that DESTROYED conversion was never
         * healed, because conversion was only ever asked whether it had improved. A metric now
         * declares which way is good and both questions are asked of it.
         *
         * The consequence to be aware of: with two metrics this produces four hypotheses per
         * challenger where it produced two, so each e-BH family is larger and the correction
         * correspondingly stricter. That is the correct trade - the alternative is not asking.
         */
        return Flux.fromIterable(challengers)
            .concatMap(challenger -> Flux.fromIterable(definitions)
                .concatMap(definition -> Flux.merge(
                    hypothesis(shell, challenger, definition, RolloutEvidence.Direction.DEGRADATION),
                    hypothesis(shell, challenger, definition, RolloutEvidence.Direction.IMPROVEMENT))))
            .collectList()
            .map(hypotheses -> new RolloutEvidence(
                candidate, since, truncated, aggregates, baseline, false, srmLogE, hypotheses));
    }

    /**
     * One challenger-versus-baseline comparison on one metric, with its e-value folded into the
     * epoch's running supremum. The supremum, not this look, is what the decision and the
     * always-valid p-value are built from.
     */
    private Mono<RolloutEvidence.Hypothesis> hypothesis(
        RolloutEvidence shell, VariantAggregate challenger,
        MetricDefinition definition, RolloutEvidence.Direction direction) {

        String metricKey = definition.key();
        double tau = definition.tau();

        VariantAggregate baseline = shell.baseline();
        long challengerHits = challenger.metric(metricKey).subjects();
        long baselineHits = baseline.metric(metricKey).subjects();

        /*
         * The one-sided test always asks "is the challenger's proportion HIGHER", so which
         * argument order expresses "worse" depends on the metric's direction. For an
         * error-shaped metric (decrease is better) a degradation is a higher proportion, which
         * is the arguments as written. For a conversion-shaped metric a degradation is a LOWER
         * proportion, so the arms swap. Getting this backwards would not fail loudly - it would
         * quietly test the opposite hypothesis and report it with full statistical ceremony.
         */
        boolean degradation = direction == RolloutEvidence.Direction.DEGRADATION;
        boolean challengerHigherIsWhatWeTest =
            definition.direction() == com.switchboard.domain.metric.MetricDirection.DECREASE_IS_BETTER
                == degradation;

        double logE = challengerHigherIsWhatWeTest
            ? MixtureSequentialTest.logEValueOneSided(
                challengerHits, challenger.subjectCount(), baselineHits, baseline.subjectCount(), tau)
            : MixtureSequentialTest.logEValueOneSided(
                baselineHits, baseline.subjectCount(), challengerHits, challenger.subjectCount(), tau);
        double zScore = TwoProportionZ.zScore(
            challengerHits, challenger.subjectCount(), baselineHits, baseline.subjectCount());

        // DIRECTION is part of the key. Without it the degradation and improvement hypotheses
        // for one metric share a running supremum, and the improvement one reads back the
        // degradation's evidence - recommending a ramp of a variation that is in fact broken.
        EpochEvidenceRepository.EpochEvidenceKey key = new EpochEvidenceRepository.EpochEvidenceKey(
            shell.candidate().environmentId(), shell.candidate().flag().key(),
            shell.candidate().epochStartedAt(), metricKey, challenger.variationId(),
            direction.name());

        return evidence.record(key, logE, tau, baseline.variationId())
            .defaultIfEmpty(logE)
            .map(supremum -> new RolloutEvidence.Hypothesis(
                shell, direction, metricKey, challenger,
                challengerHits, challenger.subjectCount(),
                baselineHits, baseline.subjectCount(),
                tau, supremum, zScore));
    }

    /**
     * The allocation gate.
     *
     * <p>Observed counts are narrowed to rollout-served subjects: traffic served by an individual
     * target or a matched rule never went through the fallthrough, so counting it against the
     * configured weights would report a mismatch the moment anyone adds a targeting rule.
     */
    private double sampleRatioLogEValue(RolloutCandidate candidate, List<VariantAggregate> aggregates) {
        if (!properties.getSrm().isEnabled()) {
            return SampleRatioMismatch.NO_EVIDENCE;
        }
        List<WeightedVariation> allocation = RolloutBaseline.allocation(candidate.config());
        if (allocation.isEmpty()) {
            return SampleRatioMismatch.NO_EVIDENCE;
        }
        Map<UUID, Long> observedByVariation = new LinkedHashMap<>();
        aggregates.forEach(agg -> observedByVariation.put(agg.variationId(), agg.rolloutSubjectCount()));

        long[] observed = new long[allocation.size()];
        int[] weights = new int[allocation.size()];
        long total = 0;
        for (int i = 0; i < allocation.size(); i++) {
            WeightedVariation weighted = allocation.get(i);
            weights[i] = weighted.weight();
            observed[i] = observedByVariation.getOrDefault(weighted.variationId(), 0L);
            if (weights[i] > 0) {
                total += observed[i];
            }
        }
        // Firing suppresses the whole flag, so it is far too blunt to trigger on a handful of
        // subjects' worth of noise.
        if (total < properties.getSrm().getMinSubjects()) {
            return SampleRatioMismatch.NO_EVIDENCE;
        }
        return SampleRatioMismatch.logEValue(observed, weights, properties.getSrm().getConcentration());
    }

    // ---------------------------------------------------------------- phase two: decide

    /**
     * Applies e-BH per (environment, direction) and acts on what survives.
     *
     * <p>The family is the environment rather than the flag: with two hundred flags a per-flag
     * family gives no protection at all, and the question an operator actually has is "how many
     * bogus rollbacks landed in production this hour". Not the whole org either - one noisy team's
     * flags would suppress another team's true findings.
     */
    private Mono<JobResult> decide(List<RolloutEvidence> measured) {
        List<RolloutEvidence.Hypothesis> rejected = new ArrayList<>();
        Map<RolloutEvidence.Hypothesis, Correction> corrections = new LinkedHashMap<>();

        for (RolloutEvidence.Direction direction : RolloutEvidence.Direction.values()) {
            double alpha = direction == RolloutEvidence.Direction.DEGRADATION
                ? properties.getAlpha().getHeal()
                : properties.getAlpha().getOptimize();

            Map<UUID, List<RolloutEvidence.Hypothesis>> byEnvironment = new LinkedHashMap<>();
            for (RolloutEvidence evidence : measured) {
                for (RolloutEvidence.Hypothesis hypothesis : evidence.hypotheses()) {
                    if (hypothesis.direction() == direction) {
                        byEnvironment
                            .computeIfAbsent(evidence.candidate().environmentId(), k -> new ArrayList<>())
                            .add(hypothesis);
                    }
                }
            }

            byEnvironment.forEach((environmentId, family) -> {
                double[] logEValues = family.stream()
                    .mapToDouble(RolloutEvidence.Hypothesis::logEValue)
                    .toArray();
                boolean[] survives = EBenjaminiHochberg.reject(logEValues, alpha);
                List<RolloutEvidence.Hypothesis> ranked = family.stream()
                    .sorted(Comparator.comparingDouble(RolloutEvidence.Hypothesis::logEValue).reversed())
                    .toList();
                for (int i = 0; i < family.size(); i++) {
                    if (survives[i]) {
                        RolloutEvidence.Hypothesis hypothesis = family.get(i);
                        rejected.add(hypothesis);
                        corrections.put(hypothesis,
                            new Correction(alpha, family.size(), ranked.indexOf(hypothesis) + 1));
                    }
                }
            });
        }

        // Degradation before improvement, strongest evidence first: a flag that is both erroring
        // and converting better should be healed, not ramped.
        List<RolloutEvidence.Hypothesis> ordered = rejected.stream()
            .sorted(Comparator
                .comparing(RolloutEvidence.Hypothesis::direction)
                .thenComparing(Comparator.comparingDouble(
                    RolloutEvidence.Hypothesis::logEValue).reversed()))
            .toList();

        Set<String> actedOn = new HashSet<>();
        int scanned = measured.size();

        return Flux.fromIterable(measured)
            .filter(RolloutEvidence::srmFailed)
            .concatMap(this::raiseSampleRatioFinding)
            .reduce(0, Integer::sum)
            .flatMap(srmFindings -> Flux.fromIterable(ordered)
                .concatMap(hypothesis -> act(hypothesis, corrections.get(hypothesis), actedOn)
                    .onErrorResume(e -> {
                        log.warn("Acting on {}/{} failed: {}",
                            hypothesis.evidence().candidate().flag().key(),
                            hypothesis.metricKey(), e.toString());
                        return Mono.just(0);
                    }))
                .reduce(srmFindings, Integer::sum))
            .map(created -> new JobResult("rollout-scan", scanned, created, detail(ordered.size())))
            .defaultIfEmpty(new JobResult("rollout-scan", scanned, 0, detail(0)));
    }

    private String detail(int rejectedCount) {
        return String.format(Locale.ROOT,
            "test=mSPRT alphaHeal=%s alphaOptimize=%s minSubjects=%d maxLookback=%s rejected=%d",
            properties.getAlpha().getHeal(), properties.getAlpha().getOptimize(),
            properties.getMinSubjects(), properties.getMaxLookback(), rejectedCount);
    }

    /** One action per flag-env per scan; the rest are recorded as findings by {@link #act}. */
    private Mono<Integer> act(
        RolloutEvidence.Hypothesis hypothesis, Correction correction, Set<String> actedOn) {

        RolloutCandidate candidate = hypothesis.evidence().candidate();
        String flagEnv = candidate.environmentId() + ":" + candidate.flag().key();
        boolean alreadyActed = !actedOn.add(flagEnv);

        return orgSettings.get(candidate.orgId())
            .flatMap(settings -> hypothesis.direction() == RolloutEvidence.Direction.DEGRADATION
                ? heal(hypothesis, correction, settings, alreadyActed)
                : optimize(hypothesis, correction, settings, alreadyActed));
    }

    // ---------------------------------------------------------------- healing

    private Mono<Integer> heal(
        RolloutEvidence.Hypothesis hypothesis, Correction correction,
        OrgSettings settings, boolean alreadyActed) {

        RolloutEvidence evidence = hypothesis.evidence();
        RolloutCandidate candidate = evidence.candidate();
        Flag flag = candidate.flag();
        VariantAggregate baseline = evidence.baseline();
        // The hypothesis names its own metric now; this used to read errorProportion()
        // unconditionally, which was only correct because degradation could only ever BE error.
        double baselineRate = baseline.proportion(hypothesis.metricKey());
        double variantRate = hypothesis.challenger().proportion(hypothesis.metricKey());

        AnomalyInput input = new AnomalyInput(
            flag.key(), candidate.envKey(),
            label(flag, hypothesis.variationId()), label(flag, baseline.variationId()),
            hypothesis.metricKey(), baselineRate, variantRate, hypothesis.zScore(),
            hypothesis.challengerSubjects(), hypothesis.baselineSubjects());

        return assistant.summarizeAnomaly(input)
            .flatMap(summary -> findings.insertIfAbsent(
                    finding(hypothesis, correction, AnomalyKind.DEGRADATION,
                        baselineRate, variantRate, summary),
                    dedupeKey(hypothesis))
                .flatMap(saved -> alreadyActed
                    ? Mono.just(1)
                    : attachRemediation(candidate, baseline, saved, summary, settings))
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
                    candidate.orgId(), candidate.projectId(), candidate.environmentId(),
                    "anomaly", candidate.flag().key(), candidate.envKey(), summary)
                .thenReturn(created));
    }

    // ---------------------------------------------------------------- optimizing

    private Mono<Integer> optimize(
        RolloutEvidence.Hypothesis hypothesis, Correction correction,
        OrgSettings settings, boolean alreadyActed) {

        RolloutEvidence evidence = hypothesis.evidence();
        RolloutCandidate candidate = evidence.candidate();
        VariantAggregate baseline = evidence.baseline();
        VariantAggregate winner = hypothesis.challenger();

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

        String rationale = String.format(
            Locale.ROOT,
            "Variation %s converts at %.1f%% of %d exposed subjects against %.1f%% of %d for %s "
                + "(always-valid p=%.4g, screened against %d hypotheses at alpha=%s). "
                + "Ramping it from %d%% to %d%% of traffic.",
            label(candidate.flag(), winner.variationId()),
            winner.proportion(hypothesis.metricKey()) * 100,
            hypothesis.challengerSubjects(), baseline.proportion(hypothesis.metricKey()) * 100,
            hypothesis.baselineSubjects(), label(candidate.flag(), baseline.variationId()),
            MixtureSequentialTest.alwaysValidP(hypothesis.logEValue()),
            correction.familySize(), correction.alpha(), current, target);

        Mono<Integer> recorded = findings.insertIfAbsent(
                finding(hypothesis, correction, AnomalyKind.IMPROVEMENT,
                    baseline.proportion(hypothesis.metricKey()),
                    winner.proportion(hypothesis.metricKey()), rationale),
                dedupeKey(hypothesis))
            .thenReturn(1)
            .defaultIfEmpty(0);

        if (alreadyActed) {
            return recorded;
        }

        Map<UUID, Integer> ramped = RolloutRamp.ramp(weights, winner.variationId(), target);
        List<ValueWeight> rollout = new ArrayList<>();
        for (Map.Entry<UUID, Integer> entry : ramped.entrySet()) {
            String value = value(candidate.flag(), entry.getKey());
            if (value == null) {
                return recorded;
            }
            rollout.add(new ValueWeight(value, entry.getValue()));
        }

        TargetingDraft draft = new TargetingDraft(
            null, null, ValueServe.ofRollout(rollout), null, null);
        FlagChangeDiff diff = updateDiff(candidate, draft);

        return recorded.then(proposals.draftExists(
                candidate.projectId(), candidate.environmentId(), candidate.flag().key(),
                ProposalKind.FLAG_UPDATE))
            .flatMap(exists -> exists
                ? Mono.just(0)
                : proposals.insertDraft(proposal(candidate, diff, rationale))
                    .flatMap(saved -> settings.autoOptimizeEnabled()
                        ? autoApply(candidate, saved, rationale).thenReturn(1)
                        : Mono.just(1)))
            .flatMap(created -> webhook.notify(
                    candidate.orgId(), candidate.projectId(), candidate.environmentId(),
                    "optimization", candidate.flag().key(), candidate.envKey(), rationale)
                .thenReturn(created));
    }

    // ---------------------------------------------------------------- sample ratio mismatch

    /**
     * Raises the SRM finding. No proposal and no remediation: there is nothing safe to automate
     * about a broken randomizer, and the fix is always a human looking at why traffic is not
     * arriving where it was sent.
     */
    private Mono<Integer> raiseSampleRatioFinding(RolloutEvidence evidence) {
        RolloutCandidate candidate = evidence.candidate();
        List<WeightedVariation> allocation = RolloutBaseline.allocation(candidate.config());

        Map<UUID, Long> observed = new LinkedHashMap<>();
        evidence.aggregates().forEach(agg -> observed.put(agg.variationId(), agg.rolloutSubjectCount()));
        long total = allocation.stream()
            .filter(weighted -> weighted.weight() > 0)
            .mapToLong(weighted -> observed.getOrDefault(weighted.variationId(), 0L))
            .sum();

        // The arm furthest from where it should be, so the finding points somewhere useful.
        WeightedVariation worst = allocation.stream()
            .filter(weighted -> weighted.weight() > 0)
            .max(Comparator.comparingDouble(weighted -> {
                double expected = weighted.weight() / 100d;
                double actual = total == 0 ? 0
                    : observed.getOrDefault(weighted.variationId(), 0L) / (double) total;
                return Math.abs(actual - expected);
            }))
            .orElse(null);
        if (worst == null || total == 0) {
            return Mono.just(0);
        }

        double expectedShare = worst.weight() / 100d;
        double actualShare = observed.getOrDefault(worst.variationId(), 0L) / (double) total;
        String summary = String.format(Locale.ROOT,
            "Traffic is not arriving as configured for %s in %s: %s was allocated %.0f%% of the "
                + "rollout but received %.1f%% of %d exposed subjects. Comparisons for this flag "
                + "are suppressed until the allocation is fixed - with randomization broken, the "
                + "variations are not comparable populations and any rate difference between them "
                + "is confounded.",
            candidate.flag().key(), candidate.envKey(),
            label(candidate.flag(), worst.variationId()),
            expectedShare * 100, actualShare * 100, total);

        AnomalyStatistics statistics = new AnomalyStatistics(
            AnomalyTestKind.DIRICHLET_MULTINOMIAL,
            evidence.srmLogEValue(),
            SampleRatioMismatch.pValue(evidence.srmLogEValue()),
            properties.getAlpha().getSrm(),
            1, 1,
            SampleRatioMismatch.pValue(evidence.srmLogEValue()),
            null,
            candidate.epochStartedAt(),
            evidence.windowTruncated(),
            null,
            null,
            observed.getOrDefault(worst.variationId(), 0L),
            null,
            total,
            null);

        String dedupeKey = String.join(":",
            candidate.environmentId().toString(), candidate.flag().key(), "SRM",
            String.valueOf(epochSeconds(candidate)));

        return findings.insertIfAbsent(new AnomalyFinding(
                    null, candidate.environmentId(), candidate.flag().key(), worst.variationId(),
                    SRM_METRIC, expectedShare, actualShare, 0d, summary,
                    AnomalyStatus.OPEN, null, null, AnomalyKind.SRM, statistics),
                dedupeKey)
            .flatMap(saved -> webhook.notify(
                    candidate.orgId(), candidate.projectId(), candidate.environmentId(),
                    "srm", candidate.flag().key(), candidate.envKey(), summary)
                .thenReturn(1))
            .defaultIfEmpty(0);
    }

    // ---------------------------------------------------------------- shared

    private AnomalyFinding finding(
        RolloutEvidence.Hypothesis hypothesis, Correction correction, AnomalyKind kind,
        double baselineRate, double variantRate, String summary) {

        RolloutEvidence evidence = hypothesis.evidence();
        RolloutCandidate candidate = evidence.candidate();
        AnomalyStatistics statistics = new AnomalyStatistics(
            AnomalyTestKind.MSPRT_GAUSSIAN_MIXTURE,
            hypothesis.logEValue(),
            MixtureSequentialTest.alwaysValidP(hypothesis.logEValue()),
            correction.alpha(),
            correction.familySize(),
            correction.familyRank(),
            SampleRatioMismatch.pValue(evidence.srmLogEValue()),
            hypothesis.tau(),
            candidate.epochStartedAt(),
            evidence.windowTruncated(),
            hypothesis.zScore(),
            evidence.baseline().variationId(),
            hypothesis.challengerSubjects(),
            hypothesis.challengerHits(),
            hypothesis.baselineSubjects(),
            hypothesis.baselineHits());

        return new AnomalyFinding(
            null, candidate.environmentId(), candidate.flag().key(), hypothesis.variationId(),
            hypothesis.metricKey(), baselineRate, variantRate, hypothesis.zScore(), summary,
            AnomalyStatus.OPEN, null, null, kind, statistics);
    }

    /**
     * Anchored to the epoch, not to the hour.
     *
     * <p>The predecessor ended this key in {@code floor(windowStart / 1 hour)} where windowStart
     * was {@code now - 48h}, so the key changed every hour and one incident could file up to 48
     * findings. Keyed on the epoch, one hypothesis yields one finding for as long as the
     * allocation stands, however often the scan runs.
     */
    private static String dedupeKey(RolloutEvidence.Hypothesis hypothesis) {
        RolloutCandidate candidate = hypothesis.evidence().candidate();
        // Direction included for the same reason it is part of the evidence key: one metric now
        // produces two hypotheses, and without it they would dedupe into one finding.
        return String.join(":",
            candidate.environmentId().toString(), candidate.flag().key(),
            String.valueOf(hypothesis.variationId()), hypothesis.metricKey(),
            hypothesis.direction().name(),
            String.valueOf(epochSeconds(candidate)));
    }

    private static long epochSeconds(RolloutCandidate candidate) {
        return candidate.epochStartedAt() == null ? 0L : candidate.epochStartedAt().getEpochSecond();
    }

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

    /** The multiplicity correction actually applied to one hypothesis. */
    private record Correction(double alpha, int familySize, int familyRank) {
    }
}
