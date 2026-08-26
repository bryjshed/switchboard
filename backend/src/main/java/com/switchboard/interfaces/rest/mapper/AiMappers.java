package com.switchboard.interfaces.rest.mapper;

import com.switchboard.application.ai.RolloutStatsService;
import com.switchboard.application.ai.TargetingDraftResolver;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.AnomalyFinding;
import com.switchboard.domain.ai.EnvChange;
import com.switchboard.domain.ai.VariantAggregate;
import com.switchboard.domain.ai.VariationDraft;
import com.switchboard.domain.flag.FlagDetail;
import com.switchboard.domain.flag.NamedEnvConfig;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.ai.AnomalyStatistics;
import com.switchboard.interfaces.rest.model.AnomalyFindingResponse;
import com.switchboard.interfaces.rest.model.AnomalyKind;
import com.switchboard.interfaces.rest.model.AnomalyTestKind;
import com.switchboard.interfaces.rest.model.AnomalyStatus;
import com.switchboard.interfaces.rest.model.FlagChangeDiff;
import com.switchboard.interfaces.rest.model.FlagKind;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.ProposalKind;
import com.switchboard.interfaces.rest.model.ProposalStatus;
import com.switchboard.interfaces.rest.model.RolloutStatsBucket;
import com.switchboard.interfaces.rest.model.RolloutStatsResponse;
import com.switchboard.interfaces.rest.model.VariantStats;
import com.switchboard.interfaces.rest.model.VariationCreate;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;

/**
 * Domain -&gt; REST for the AI surface.
 *
 * <p>The domain diff names variations by VALUE (see FlagAssistantPort's
 * tool-schema convention) and only carries the fields the change touches, while
 * the REST FlagTargetingConfig is keyed by UUID and is whole. Rendering therefore
 * runs the very same resolver the apply path runs, against the flag's current
 * head config: what a reviewer sees is exactly what applying would write. For a
 * FLAG_CREATE proposal there is no flag yet, so the per-environment
 * {@code config} is left out and enabled/killSwitchActive carry the intent.
 */
public final class AiMappers {

    private static final int RATE_SCALE = 6;

    private AiMappers() {
    }

    public static com.switchboard.interfaces.rest.model.AiProposalResponse toProposalResponse(
        AiProposal proposal, FlagDetail target) {
        return toProposalResponse(proposal, target, null);
    }

    /**
     * @param pendingChangeRequestId the open change request this proposal is parked behind, or
     *     null. Needed because a parked proposal is still DRAFT - it has genuinely not been
     *     applied - so without it the response cannot distinguish "awaiting review" from
     *     "nobody has acted on this", and those call for opposite actions from whoever is
     *     looking at the list.
     */
    public static com.switchboard.interfaces.rest.model.AiProposalResponse toProposalResponse(
        AiProposal proposal, FlagDetail target, java.util.UUID pendingChangeRequestId) {
        return new com.switchboard.interfaces.rest.model.AiProposalResponse(
            proposal.id(),
            proposal.orgId(),
            proposal.projectId(),
            ProposalKind.valueOf(proposal.kind().name()),
            toDiff(proposal.diff(), target),
            ProposalStatus.valueOf(proposal.status().name()),
            proposal.createdBy(),
            proposal.createdAt())
            .environmentId(proposal.environmentId())
            .sourcePrompt(proposal.sourcePrompt())
            .rationale(proposal.rationale())
            .appliedBy(proposal.appliedBy())
            .appliedVersion(proposal.appliedVersion())
            .pendingChangeRequestId(pendingChangeRequestId);
    }

    /** {@code target} is the flag the diff edits, or null for a FLAG_CREATE. */
    public static FlagChangeDiff toDiff(
        com.switchboard.domain.ai.FlagChangeDiff diff, FlagDetail target) {
        FlagChangeDiff rest = new FlagChangeDiff(
            ProposalKind.valueOf(diff.kind().name()), diff.flagKey())
            .name(diff.name())
            .description(diff.description())
            .variations(diff.variations().stream().map(AiMappers::toVariationCreate).toList())
            .tags(diff.tags())
            .envChanges(diff.envChanges().stream()
                .map(change -> toEnvChange(change, target))
                .toList())
            .rollbackToVersion(diff.rollbackToVersion())
            .retirementChecklist(diff.retirementChecklist());
        if (diff.flagKind() != null) {
            rest.flagKind(FlagKind.valueOf(diff.flagKind().name()));
        }
        return rest;
    }

    private static VariationCreate toVariationCreate(VariationDraft draft) {
        return new VariationCreate(draft.value()).name(draft.name());
    }

    private static com.switchboard.interfaces.rest.model.EnvChange toEnvChange(
        EnvChange change, FlagDetail target) {
        com.switchboard.interfaces.rest.model.EnvChange rest =
            new com.switchboard.interfaces.rest.model.EnvChange(change.envKey())
                .enabled(change.enabled())
                .killSwitchActive(change.killSwitchActive());
        FlagTargetingConfig config = resolvedConfig(change, target);
        return config == null ? rest : rest.config(config);
    }

    /**
     * The whole config the change would produce, or null when it cannot be known
     * yet (no such flag, no head in that environment, or a variation value that
     * no longer resolves because the flag changed since the proposal was drafted).
     */
    private static FlagTargetingConfig resolvedConfig(EnvChange change, FlagDetail target) {
        if (change.targeting() == null || target == null) {
            return null;
        }
        Optional<NamedEnvConfig> head = target.envConfigs().stream()
            .filter(named -> named.envKey().equals(change.envKey()))
            .findFirst();
        if (head.isEmpty()) {
            return null;
        }
        try {
            TargetingConfig resolved = TargetingDraftResolver.resolve(
                target.flag(), head.get().config().config(), change.targeting());
            return FlagMappers.toRestConfig(resolved);
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- anomalies

    public static AnomalyFindingResponse toAnomalyResponse(AnomalyFinding finding) {
        AnomalyStatistics statistics = finding.statistics() == null
            ? AnomalyStatistics.none()
            : finding.statistics();
        return new AnomalyFindingResponse(
            finding.id(),
            finding.environmentId(),
            finding.flagKey(),
            finding.metricKey(),
            rate(finding.baselineRate()),
            rate(finding.variantRate()),
            AnomalyStatus.valueOf(finding.status().name()),
            finding.createdAt(),
            AnomalyKind.valueOf(finding.kind().name()),
            AnomalyTestKind.valueOf(statistics.testKind().name()))
            .variationId(finding.variationId())
            .summary(finding.summary())
            .suggestedProposalId(finding.suggestedProposalId())
            // Descriptive only, and absent on SRM findings - a 0.00 there would read as
            // "measured, no effect" rather than "not applicable".
            .zScore(scaled(statistics.zScore()))
            .pValue(scaled(statistics.pValue()))
            .logEValue(scaled(statistics.logEValue()))
            .alpha(scaled(statistics.alpha()))
            .familySize(statistics.familySize())
            .familyRank(statistics.familyRank())
            .srmPValue(scaled(statistics.srmPValue()))
            .tau(scaled(statistics.tau()))
            .epochStartedAt(statistics.epochStartedAt())
            .windowTruncated(statistics.windowTruncated())
            .variantSubjects(statistics.variantSubjects())
            .variantHits(statistics.variantHits())
            .baselineSubjects(statistics.baselineSubjects())
            .baselineHits(statistics.baselineHits())
            .baselineVariationId(statistics.baselineVariationId());
    }

    /** Six places, so a p-value near zero survives the round trip instead of rendering as 0.0000. */
    private static BigDecimal scaled(Double value) {
        return value == null ? null : BigDecimal.valueOf(value).setScale(6, RoundingMode.HALF_UP);
    }

    // ---------------------------------------------------------------- rollout stats

    public static RolloutStatsResponse toStatsResponse(RolloutStatsService.RolloutStats stats) {
        Function<UUID, String> names = stats.nameLookup();
        return new RolloutStatsResponse(
            stats.flagKey(),
            stats.environmentId(),
            stats.totals().stream().map(agg -> toVariantStats(agg, names)).toList(),
            stats.buckets().stream()
                .map(bucket -> new RolloutStatsBucket(
                    bucket.bucketStart(),
                    bucket.variants().stream().map(agg -> toVariantStats(agg, names)).toList()))
                .toList());
    }

    private static VariantStats toVariantStats(VariantAggregate agg, Function<UUID, String> names) {
        return new VariantStats(
            agg.variationId(), agg.evalCount(), rate(agg.errorRate()), rate(agg.conversionRate()))
            .variationName(names.apply(agg.variationId()));
    }

    private static BigDecimal rate(double value) {
        return BigDecimal.valueOf(value).setScale(RATE_SCALE, RoundingMode.HALF_UP);
    }
}
