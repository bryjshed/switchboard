package com.switchboard.domain.flag;

import java.util.List;
import java.util.UUID;

public record TargetingConfig(
    List<IndividualTarget> individualTargets,
    List<Rule> rules,
    RolloutOrVariation fallthrough,
    UUID offVariationId,
    UUID defaultVariationId) {

    public TargetingConfig {
        if (fallthrough == null) {
            throw new IllegalArgumentException("fallthrough is required");
        }
        if (offVariationId == null) {
            throw new IllegalArgumentException("offVariationId is required");
        }
        if (defaultVariationId == null) {
            throw new IllegalArgumentException("defaultVariationId is required");
        }
        individualTargets = individualTargets == null ? List.of() : List.copyOf(individualTargets);
        rules = rules == null ? List.of() : List.copyOf(rules);
    }

    /**
     * The configuration a flag gets in an environment it has never been configured in: serve
     * the default variation, no rules, no individual targets.
     *
     * <p>Lives here rather than in the service that creates flags because TWO paths need it and
     * they must agree - creating a flag seeds every existing environment, and creating an
     * environment backfills every existing flag. When only the first existed, the second was
     * missing entirely and every flag evaluated to the caller's default in a new environment.
     *
     * <p>Returns null for a flag with fewer than two variations rather than throwing: the
     * callers differ on whether that is a user error (creating a flag) or an impossibility
     * (backfilling one that already exists), so the decision belongs to them.
     */
    public static TargetingConfig initialFor(List<Variation> variations) {
        if (variations == null || variations.size() < 2) {
            return null;
        }
        // BOOLEAN: off=false (last), default=true (first). STRING: off=last, default=first.
        UUID defaultVariationId = variations.get(0).id();
        UUID offVariationId = variations.get(variations.size() - 1).id();
        return new TargetingConfig(
            List.of(), List.of(), RolloutOrVariation.ofVariation(defaultVariationId),
            offVariationId, defaultVariationId);
    }
}
