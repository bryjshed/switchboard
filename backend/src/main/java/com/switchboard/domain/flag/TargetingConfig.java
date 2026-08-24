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
}
