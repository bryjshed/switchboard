package com.switchboard.domain.ai.stats;

/**
 * Two-proportion z-test, the screen that keeps the monitor from reacting to
 * noise. A positive z means the variant's rate is higher than the baseline's;
 * for an error metric higher is worse, for a conversion metric higher is better.
 */
public final class TwoProportionZ {

    private TwoProportionZ() {
    }

    /** Returns 0 when either side has no samples or the pooled variance vanishes. */
    public static double zScore(long variantHits, long variantTotal, long baselineHits, long baselineTotal) {
        if (variantTotal <= 0 || baselineTotal <= 0) {
            return 0d;
        }
        double p1 = (double) variantHits / variantTotal;
        double p2 = (double) baselineHits / baselineTotal;
        double pooled = (double) (variantHits + baselineHits) / (variantTotal + baselineTotal);
        double variance = pooled * (1 - pooled) * (1.0 / variantTotal + 1.0 / baselineTotal);
        if (variance <= 0) {
            return 0d;
        }
        return (p1 - p2) / Math.sqrt(variance);
    }
}
