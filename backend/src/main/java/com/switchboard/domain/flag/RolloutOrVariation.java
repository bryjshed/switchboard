package com.switchboard.domain.flag;

import java.util.List;
import java.util.UUID;

/**
 * Either a fixed variation or a percentage rollout - exactly one is set.
 * Rollout weights must sum to exactly 100.
 */
public record RolloutOrVariation(UUID variationId, List<WeightedVariation> rollout) {

    public RolloutOrVariation {
        boolean hasVariation = variationId != null;
        boolean hasRollout = rollout != null && !rollout.isEmpty();
        if (hasVariation == hasRollout) {
            throw new IllegalArgumentException("serve must set exactly one of variationId or rollout");
        }
        if (hasRollout) {
            rollout = List.copyOf(rollout);
            int sum = rollout.stream().mapToInt(WeightedVariation::weight).sum();
            if (sum != 100) {
                throw new IllegalArgumentException("rollout weights must sum to exactly 100, got " + sum);
            }
        }
    }

    public static RolloutOrVariation ofVariation(UUID variationId) {
        return new RolloutOrVariation(variationId, null);
    }

    public static RolloutOrVariation ofRollout(List<WeightedVariation> rollout) {
        return new RolloutOrVariation(null, rollout);
    }

    public boolean hasRollout() {
        return rollout != null && !rollout.isEmpty();
    }
}
