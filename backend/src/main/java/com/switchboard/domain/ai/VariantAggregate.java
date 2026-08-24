package com.switchboard.domain.ai;

import java.util.UUID;

/**
 * One variation's telemetry over a window. Metric events are attributed to the
 * variation that the same context_key was evaluated into during the window -
 * see {@link RolloutMetricsRepository} for why that simplification is safe here.
 */
public record VariantAggregate(UUID variationId, long evalCount, long errorCount, long conversionCount) {

    public double errorRate() {
        return rate(errorCount);
    }

    public double conversionRate() {
        return rate(conversionCount);
    }

    private double rate(long numerator) {
        if (evalCount <= 0) {
            return 0d;
        }
        return Math.min(1d, (double) numerator / (double) evalCount);
    }
}
