package com.switchboard.interfaces.rest.mapper;

import com.switchboard.application.audit.AuditEntry;
import com.switchboard.application.evaluation.EnvSnapshot;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.evaluation.EvalOutcome;
import com.switchboard.domain.flag.Clause;
import com.switchboard.domain.flag.ClauseOp;
import com.switchboard.domain.flag.FlagAndConfig;
import com.switchboard.domain.flag.FlagDetail;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.flag.FlagEnvConfigVersion;
import com.switchboard.domain.flag.FlagEnvSummaryView;
import com.switchboard.domain.flag.FlagListItem;
import com.switchboard.domain.flag.IndividualTarget;
import com.switchboard.domain.flag.NamedEnvConfig;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.Rule;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.flag.WeightedVariation;
import com.switchboard.domain.segment.Segment;
import com.switchboard.domain.segment.SegmentRule;
import com.switchboard.interfaces.rest.model.AuditAction;
import com.switchboard.interfaces.rest.model.AuditEntryResponse;
import com.switchboard.interfaces.rest.model.BootstrapFlag;
import com.switchboard.interfaces.rest.model.BootstrapResponse;
import com.switchboard.interfaces.rest.model.ClientBootstrapFlag;
import com.switchboard.interfaces.rest.model.BootstrapSegment;
import com.switchboard.interfaces.rest.model.EvalReason;
import com.switchboard.interfaces.rest.model.EvalResult;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigResponse;
import com.switchboard.interfaces.rest.model.FlagEnvSummary;
import com.switchboard.interfaces.rest.model.FlagKind;
import com.switchboard.interfaces.rest.model.FlagSummaryResponse;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.FlagVersionResponse;
import com.switchboard.interfaces.rest.model.SegmentResponse;
import com.switchboard.interfaces.rest.model.SegmentUpsertRequest;
import java.util.List;
import java.util.UUID;

/** Domain <-> generated REST model mapping for flags, segments, eval, and audit. */
public final class FlagMappers {

    private FlagMappers() {
    }

    // ---------------------------------------------------------------- REST -> domain

    /** Domain invariants (exactly-one serve, weights sum 100) surface as 400s here. */
    public static TargetingConfig toDomainConfig(FlagTargetingConfig rest) {
        try {
            return new TargetingConfig(
                rest.getIndividualTargets().stream().map(FlagMappers::toDomainTarget).toList(),
                rest.getRules().stream().map(FlagMappers::toDomainRule).toList(),
                toDomainServe(rest.getFallthrough()),
                rest.getOffVariationId(),
                rest.getDefaultVariationId());
        } catch (IllegalArgumentException e) {
            throw new ValidationException(e.getMessage());
        }
    }

    private static IndividualTarget toDomainTarget(com.switchboard.interfaces.rest.model.IndividualTarget rest) {
        return new IndividualTarget(rest.getContextKey(), rest.getVariationId());
    }

    private static Rule toDomainRule(com.switchboard.interfaces.rest.model.Rule rest) {
        return new Rule(
            rest.getId(),
            rest.getDescription(),
            rest.getClauses().stream().map(FlagMappers::toDomainClause).toList(),
            toDomainServe(rest.getServe()));
    }

    private static Clause toDomainClause(com.switchboard.interfaces.rest.model.Clause rest) {
        return new Clause(
            rest.getAttribute(),
            ClauseOp.valueOf(rest.getOp().name()),
            rest.getValues(),
            // Absent means false: every clause written before per-clause negation existed.
            Boolean.TRUE.equals(rest.getNegate()));
    }

    private static RolloutOrVariation toDomainServe(com.switchboard.interfaces.rest.model.RolloutOrVariation rest) {
        List<WeightedVariation> rollout = rest.getRollout().stream()
            .map(w -> new WeightedVariation(w.getVariationId(), w.getWeight()))
            .toList();
        return new RolloutOrVariation(rest.getVariationId(), rollout);
    }

    public static Segment toDomainSegment(UUID projectId, String key, SegmentUpsertRequest rest) {
        try {
            return new Segment(
                null, projectId, key, rest.getName(),
                rest.getIncludedKeys(), rest.getExcludedKeys(),
                rest.getRules().stream().map(FlagMappers::toDomainSegmentRule).toList(),
                null);
        } catch (IllegalArgumentException e) {
            throw new ValidationException(e.getMessage());
        }
    }

    private static SegmentRule toDomainSegmentRule(com.switchboard.interfaces.rest.model.SegmentRule rest) {
        return new SegmentRule(rest.getClauses().stream().map(FlagMappers::toDomainClause).toList());
    }

    // ---------------------------------------------------------------- domain -> REST

    public static FlagTargetingConfig toRestConfig(TargetingConfig config) {
        return new FlagTargetingConfig(
            toRestServe(config.fallthrough()), config.offVariationId(), config.defaultVariationId())
            .individualTargets(config.individualTargets().stream().map(FlagMappers::toRestTarget).toList())
            .rules(config.rules().stream().map(FlagMappers::toRestRule).toList());
    }

    private static com.switchboard.interfaces.rest.model.IndividualTarget toRestTarget(IndividualTarget target) {
        return new com.switchboard.interfaces.rest.model.IndividualTarget(
            target.contextKey(), target.variationId());
    }

    private static com.switchboard.interfaces.rest.model.Rule toRestRule(Rule rule) {
        return new com.switchboard.interfaces.rest.model.Rule(
            rule.id(),
            rule.clauses().stream().map(FlagMappers::toRestClause).toList(),
            toRestServe(rule.serve()))
            .description(rule.description());
    }

    private static com.switchboard.interfaces.rest.model.Clause toRestClause(Clause clause) {
        return new com.switchboard.interfaces.rest.model.Clause(
            clause.attribute(),
            com.switchboard.interfaces.rest.model.ClauseOp.valueOf(clause.op().name()),
            clause.values())
            .negate(clause.negate());
    }

    private static com.switchboard.interfaces.rest.model.RolloutOrVariation toRestServe(RolloutOrVariation serve) {
        com.switchboard.interfaces.rest.model.RolloutOrVariation rest =
            new com.switchboard.interfaces.rest.model.RolloutOrVariation();
        if (serve.hasRollout()) {
            rest.rollout(serve.rollout().stream()
                .map(w -> new com.switchboard.interfaces.rest.model.WeightedVariation(w.variationId(), w.weight()))
                .toList());
        } else {
            rest.variationId(serve.variationId());
        }
        return rest;
    }

    public static com.switchboard.interfaces.rest.model.Variation toRestVariation(Variation variation) {
        return new com.switchboard.interfaces.rest.model.Variation(variation.id(), variation.value())
            .name(variation.name());
    }

    /**
     * One evaluated flag for a client payload. Served variation only: no rules, no segment
     * membership, and no sibling variations.
     *
     * <p>{@code ruleId} and {@code variationName} are included because both are already public
     * API on the SDK's EvaluationDetail, and a bare UUID with no accompanying clauses reveals
     * essentially nothing. Flag it in review if your variation names are themselves sensitive.
     */
    public static ClientBootstrapFlag toClientBootstrapFlag(FlagAndConfig fc, EvalOutcome outcome) {
        Variation served = fc.flag().variationById(outcome.variationId());
        return new ClientBootstrapFlag(
            fc.flag().key(),
            FlagKind.valueOf(fc.flag().kind().name()),
            outcome.value() == null ? "" : outcome.value(),
            EvalReason.valueOf(outcome.reason().name()))
            .variationId(outcome.variationId())
            .variationName(served == null ? null : served.name())
            .ruleId(outcome.ruleId())
            .version(fc.config().version());
    }

    public static FlagDetailResponse toFlagDetailResponse(FlagDetail detail) {
        return new FlagDetailResponse(
            detail.flag().id(),
            detail.flag().projectId(),
            detail.flag().key(),
            detail.flag().name(),
            FlagKind.valueOf(detail.flag().kind().name()),
            detail.flag().variations().stream().map(FlagMappers::toRestVariation).toList(),
            detail.flag().tags(),
            detail.envConfigs().stream().map(FlagMappers::toEnvConfigResponse).toList())
            .description(detail.flag().description())
            .clientSideAvailable(detail.flag().clientSideAvailable());
    }

    public static FlagEnvConfigResponse toEnvConfigResponse(NamedEnvConfig named) {
        return toEnvConfigResponse(named.envKey(), named.config());
    }

    public static FlagEnvConfigResponse toEnvConfigResponse(String envKey, FlagEnvConfig config) {
        return new FlagEnvConfigResponse(
            config.flagId(),
            config.environmentId(),
            envKey,
            config.enabled(),
            config.killSwitchActive(),
            toRestConfig(config.config()),
            config.version(),
            config.updatedAt(),
            config.updatedBy());
    }

    public static FlagSummaryResponse toSummaryResponse(FlagListItem item) {
        return new FlagSummaryResponse(
            item.id(),
            item.key(),
            item.name(),
            FlagKind.valueOf(item.kind().name()),
            item.tags(),
            item.environments().stream().map(FlagMappers::toEnvSummary).toList());
    }

    private static FlagEnvSummary toEnvSummary(FlagEnvSummaryView view) {
        return new FlagEnvSummary(view.envKey(), view.enabled(), view.killSwitchActive(), view.version())
            .rolloutPercentage(view.rolloutPercentage())
            .updatedAt(view.updatedAt())
            .updatedBy(view.updatedBy());
    }

    public static FlagVersionResponse toVersionResponse(FlagEnvConfigVersion version) {
        return new FlagVersionResponse(
            version.versionNumber(),
            version.enabled(),
            version.killSwitchActive(),
            toRestConfig(version.config()),
            version.createdBy(),
            version.createdAt())
            .versionNote(version.versionNote())
            .createdFromProposalId(version.createdFromProposalId());
    }

    public static SegmentResponse toSegmentResponse(Segment segment) {
        return new SegmentResponse(
            segment.id(),
            segment.projectId(),
            segment.key(),
            segment.name(),
            segment.includedKeys(),
            segment.excludedKeys(),
            segment.rules().stream().map(FlagMappers::toRestSegmentRule).toList())
            .updatedAt(segment.updatedAt());
    }

    private static com.switchboard.interfaces.rest.model.SegmentRule toRestSegmentRule(SegmentRule rule) {
        return new com.switchboard.interfaces.rest.model.SegmentRule(
            rule.clauses().stream().map(FlagMappers::toRestClause).toList());
    }

    public static BootstrapResponse toBootstrapResponse(EnvSnapshot snapshot) {
        return new BootstrapResponse(
            snapshot.envKey(),
            snapshot.stateVersion(),
            snapshot.flags().stream()
                .map(fc -> new BootstrapFlag(
                    fc.flag().key(),
                    FlagKind.valueOf(fc.flag().kind().name()),
                    fc.flag().variations().stream().map(FlagMappers::toRestVariation).toList(),
                    fc.config().enabled(),
                    fc.config().killSwitchActive(),
                    toRestConfig(fc.config().config()),
                    fc.config().version()))
                .toList(),
            snapshot.segmentsByKey().values().stream()
                .sorted(java.util.Comparator.comparing(Segment::key))
                .map(segment -> new BootstrapSegment(
                    segment.key(),
                    segment.includedKeys(),
                    segment.excludedKeys(),
                    segment.rules().stream().map(FlagMappers::toRestSegmentRule).toList()))
                .toList());
    }

    public static EvalResult toEvalResult(String flagKey, Integer flagVersion, EvalOutcome outcome) {
        return new EvalResult(
            flagKey,
            outcome.value() == null ? "" : outcome.value(),
            EvalReason.valueOf(outcome.reason().name()))
            .variationId(outcome.variationId())
            .ruleId(outcome.ruleId())
            .flagVersion(flagVersion);
    }

    public static AuditEntryResponse toAuditEntryResponse(AuditEntry entry) {
        return new AuditEntryResponse(
            entry.id(),
            entry.orgId(),
            AuditAction.valueOf(entry.action()),
            entry.actor(),
            entry.createdAt())
            .projectId(entry.projectId())
            .environmentId(entry.environmentId())
            .envKey(entry.envKey())
            .flagKey(entry.flagKey())
            .reason(entry.reason())
            .versionFrom(entry.versionFrom())
            .versionTo(entry.versionTo());
    }
}
