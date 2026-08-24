package com.switchboard.domain.flag;

import java.util.UUID;

public record WeightedVariation(UUID variationId, int weight) {

    public WeightedVariation {
        if (variationId == null) {
            throw new IllegalArgumentException("rollout variationId is required");
        }
        if (weight < 0 || weight > 100) {
            throw new IllegalArgumentException("rollout weight must be between 0 and 100");
        }
    }
}
