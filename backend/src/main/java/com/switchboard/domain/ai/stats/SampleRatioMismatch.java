package com.switchboard.domain.ai.stats;

/**
 * Detects a sample ratio mismatch: traffic not arriving in the proportions the rollout configured.
 *
 * <h2>Why this gates everything else</h2>
 *
 * <p>A 50/50 rollout that delivers 800 subjects to one arm and 200 to the other has a broken
 * randomizer - a bucketing bug, a sticky cache, an SDK ignoring weights, or telemetry loss
 * correlated with the variant. Whatever the cause, the two arms are no longer comparable
 * populations, so every downstream rate comparison is confounded. Acting on one means automatically
 * rolling back a flag on the strength of an artifact.
 *
 * <p>So this is a gate, not a signal: when it fires, the flag's comparisons are suppressed for the
 * rest of the epoch and a finding is raised for a human. There is nothing safe to automate about a
 * broken randomizer.
 *
 * <h2>Why not chi-square</h2>
 *
 * <p>Chi-square goodness of fit at p &lt; 0.001 is the industry-standard SRM check, and it is the
 * wrong tool <em>here</em> for the same reason the fixed-horizon z-test was: this runs repeatedly
 * against a cumulative window, so a fixed-horizon test will eventually fire on a perfectly healthy
 * rollout. Using it would reintroduce the exact defect being fixed one layer down.
 *
 * <p>The Dirichlet-multinomial e-value below is anytime-valid, so it composes with the rest of the
 * design. {@link #chiSquare} is kept, but only as a descriptive statistic for display.
 *
 * <h2>The formula</h2>
 *
 * <p>With observed counts {@code O_i}, configured weights {@code w_i} summing to 100, total
 * {@code N}, and a Dirichlet prior {@code a_i = c * w_i / 100} concentrated on those weights:
 *
 * <pre>
 *   ln E = sum_i lnGamma(a_i + O_i) - lnGamma(c + N) - sum_i lnGamma(a_i) + lnGamma(c)
 *          - sum_i O_i ln(w_i / 100)
 * </pre>
 *
 * <p>{@code c} selects <em>which size</em> of mismatch the test is most powerful against, by setting
 * the scale of the alternative it is testing. A small {@code c} spreads the alternative over
 * lopsided splits and is therefore strongest against gross breakage; a large {@code c} concentrates
 * it near the configured weights and is strongest against subtle drift, at the cost of some power
 * against the gross case. Measured on a 50/50 config: at 530/470 the log e-value rises from -1.88
 * at {@code c = 1} to +0.44 at {@code c = 100}, while at 800/200 it falls from 189 to 172.
 *
 * <p>{@code c = 1} is weakly informative and is the default, because gross breakage is what this
 * gate is for. Subtle allocation drift is a data-quality question, not a reason to suppress a
 * flag's comparisons.
 */
public final class SampleRatioMismatch {

    /** Returned when the inputs cannot support a test. Never rejects. */
    public static final double NO_EVIDENCE = 0.0;

    private SampleRatioMismatch() {
    }

    /**
     * Log of the e-value against the null that traffic arrived in the configured proportions.
     *
     * <p>Only arms with a positive configured weight participate: an arm configured to receive no
     * traffic is not part of the allocation being tested. Observed traffic on a zero-weight arm is
     * a different fault, and one this test would report as an infinite surprise.
     *
     * @param observed subject counts per arm, aligned with {@code weights}
     * @param weights configured whole-percent weights per arm, summing to 100
     * @param concentration the Dirichlet concentration {@code c}; 1.0 is the default
     * @return {@code ln(E)}, or {@link #NO_EVIDENCE} when no test is possible
     */
    public static double logEValue(long[] observed, int[] weights, double concentration) {
        if (observed == null || weights == null || observed.length != weights.length) {
            return NO_EVIDENCE;
        }
        if (!(concentration > 0) || !Double.isFinite(concentration)) {
            return NO_EVIDENCE;
        }

        double weightTotal = 0;
        long total = 0;
        int participating = 0;
        for (int i = 0; i < weights.length; i++) {
            if (weights[i] > 0) {
                weightTotal += weights[i];
                total += Math.max(0, observed[i]);
                participating++;
            }
        }
        // One arm carries no allocation information: it is expected to get everything, and does.
        if (participating < 2 || total <= 0 || weightTotal <= 0) {
            return NO_EVIDENCE;
        }

        double logEValue = LogGamma.lnGamma(concentration) - LogGamma.lnGamma(concentration + total);
        for (int i = 0; i < weights.length; i++) {
            if (weights[i] <= 0) {
                continue;
            }
            double share = weights[i] / weightTotal;
            double prior = concentration * share;
            long count = Math.max(0, observed[i]);
            logEValue += LogGamma.lnGamma(prior + count) - LogGamma.lnGamma(prior);
            logEValue -= count * Math.log(share);
        }
        return logEValue;
    }

    /**
     * The classic chi-square goodness-of-fit statistic. Descriptive only - the decision uses
     * {@link #logEValue}. Kept because a chi-square is what an operator investigating an SRM will
     * recognise and cross-check against their own tooling.
     */
    public static double chiSquare(long[] observed, int[] weights) {
        if (observed == null || weights == null || observed.length != weights.length) {
            return 0.0;
        }
        double weightTotal = 0;
        long total = 0;
        for (int i = 0; i < weights.length; i++) {
            if (weights[i] > 0) {
                weightTotal += weights[i];
                total += Math.max(0, observed[i]);
            }
        }
        if (total <= 0 || weightTotal <= 0) {
            return 0.0;
        }
        double statistic = 0;
        for (int i = 0; i < weights.length; i++) {
            if (weights[i] <= 0) {
                continue;
            }
            double expected = total * (weights[i] / weightTotal);
            if (expected <= 0) {
                continue;
            }
            double delta = Math.max(0, observed[i]) - expected;
            statistic += delta * delta / expected;
        }
        return statistic;
    }

    /** The e-value read as a p-value for display, {@code min(1, 1/E)}. */
    public static double pValue(double logEValue) {
        return MixtureSequentialTest.alwaysValidP(logEValue);
    }
}
