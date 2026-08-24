package com.switchboard.application.ai;

import com.switchboard.domain.ai.TargetingDraft;
import com.switchboard.domain.ai.ValueClause;
import com.switchboard.domain.ai.ValueRule;
import com.switchboard.domain.ai.ValueServe;
import com.switchboard.domain.ai.ValueTarget;
import com.switchboard.domain.ai.ValueWeight;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.flag.Clause;
import com.switchboard.domain.flag.ClauseOp;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.IndividualTarget;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.Rule;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.flag.WeightedVariation;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Turns a value-keyed {@link TargetingDraft} into a real {@link TargetingConfig}
 * against a concrete flag. Two things happen here and nowhere else:
 *
 * <ul>
 *   <li>variation VALUE -&gt; UUID resolution, which is only possible once the
 *       flag exists (for FLAG_CREATE that means after FlagService.create);</li>
 *   <li>overlay semantics - a null field on the draft keeps the current head's
 *       value, so a proposal can say "serve 100% control" without restating
 *       rules, targets, and off/default variations.</li>
 * </ul>
 */
public final class TargetingDraftResolver {

    private TargetingDraftResolver() {
    }

    /** Resolves the draft over {@code current}; a null draft returns {@code current} unchanged. */
    public static TargetingConfig resolve(Flag flag, TargetingConfig current, TargetingDraft draft) {
        if (draft == null) {
            return current;
        }
        Map<String, UUID> byValue = variationIndex(flag);
        try {
            return new TargetingConfig(
                draft.individualTargets() == null
                    ? current.individualTargets()
                    : draft.individualTargets().stream()
                        .map(target -> toTarget(byValue, target))
                        .toList(),
                draft.rules() == null
                    ? current.rules()
                    : draft.rules().stream().map(rule -> toRule(byValue, rule)).toList(),
                draft.fallthrough() == null
                    ? current.fallthrough()
                    : toServe(byValue, draft.fallthrough()),
                draft.offVariationValue() == null
                    ? current.offVariationId()
                    : require(byValue, draft.offVariationValue()),
                draft.defaultVariationValue() == null
                    ? current.defaultVariationId()
                    : require(byValue, draft.defaultVariationValue()));
        } catch (IllegalArgumentException e) {
            throw new ValidationException(e.getMessage());
        }
    }

    /** Every variation value the draft names must exist on the flag. */
    public static void validateResolvable(Flag flag, TargetingDraft draft) {
        if (draft == null) {
            return;
        }
        Map<String, UUID> byValue = variationIndex(flag);
        if (draft.offVariationValue() != null) {
            require(byValue, draft.offVariationValue());
        }
        if (draft.defaultVariationValue() != null) {
            require(byValue, draft.defaultVariationValue());
        }
        requireServe(byValue, draft.fallthrough());
        if (draft.individualTargets() != null) {
            draft.individualTargets().forEach(target -> require(byValue, target.variationValue()));
        }
        if (draft.rules() != null) {
            draft.rules().forEach(rule -> requireServe(byValue, rule.serve()));
        }
    }

    /** Value -&gt; id for the flag's variations; values are unique per flag by construction. */
    private static Map<String, UUID> variationIndex(Flag flag) {
        Map<String, UUID> byValue = new LinkedHashMap<>();
        for (Variation variation : flag.variations()) {
            byValue.putIfAbsent(variation.value(), variation.id());
        }
        return byValue;
    }

    private static IndividualTarget toTarget(Map<String, UUID> byValue, ValueTarget target) {
        return new IndividualTarget(target.contextKey(), require(byValue, target.variationValue()));
    }

    private static Rule toRule(Map<String, UUID> byValue, ValueRule rule) {
        return new Rule(
            UUID.randomUUID(),
            rule.description(),
            rule.clauses().stream().map(TargetingDraftResolver::toClause).toList(),
            toServe(byValue, rule.serve()));
    }

    private static Clause toClause(ValueClause clause) {
        ClauseOp op;
        try {
            op = ClauseOp.valueOf(clause.op());
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new ValidationException("Unknown clause op: " + clause.op());
        }
        return new Clause(clause.attribute(), op, clause.values());
    }

    private static RolloutOrVariation toServe(Map<String, UUID> byValue, ValueServe serve) {
        if (serve == null) {
            throw new ValidationException("serve is required");
        }
        if (serve.hasRollout()) {
            List<WeightedVariation> rollout = serve.rollout().stream()
                .map(weight -> new WeightedVariation(require(byValue, weight.variationValue()), weight.weight()))
                .toList();
            return RolloutOrVariation.ofRollout(rollout);
        }
        return RolloutOrVariation.ofVariation(require(byValue, serve.variationValue()));
    }

    private static void requireServe(Map<String, UUID> byValue, ValueServe serve) {
        if (serve == null) {
            return;
        }
        if (serve.hasRollout()) {
            serve.rollout().stream().map(ValueWeight::variationValue).forEach(value -> require(byValue, value));
        } else {
            require(byValue, serve.variationValue());
        }
    }

    private static UUID require(Map<String, UUID> byValue, String value) {
        UUID id = byValue.get(value);
        if (id == null) {
            throw new ValidationException(
                "Unknown variation value \"" + value + "\"; known values are " + byValue.keySet());
        }
        return id;
    }
}
