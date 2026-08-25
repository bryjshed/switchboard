package com.switchboard.domain.ai.stats;

/**
 * A mixture sequential probability ratio test for the difference of two proportions, reported as an
 * e-value.
 *
 * <h2>Why this exists</h2>
 *
 * <p>The predecessor was a fixed-horizon two-proportion z-test evaluated repeatedly on a schedule.
 * A fixed-horizon statistic is calibrated for <em>one</em> look. Looking again every hour and
 * reacting to whichever look crosses the threshold inflates the false-positive rate without bound:
 * given enough looks, a rollout with two identical variants will eventually be rolled back. That is
 * the peeking problem, and it sat underneath the automated healing loop - the feature the product
 * leads with.
 *
 * <p>The fix is a statistic that is valid at <em>every</em> stopping time, not just a
 * pre-committed one. Under the null, the e-value here is a nonnegative supermartingale, so Ville's
 * inequality bounds the probability that it <em>ever</em> reaches 1/alpha by alpha - no matter how
 * often it is inspected, and no matter that the decision to stop depends on the data.
 *
 * <h2>The formulas</h2>
 *
 * <p>Arm 1 is the challenger, arm 2 the baseline, and the counts are <em>subjects</em>, not
 * evaluation events. Let
 *
 * <pre>
 *   d  = x1/n1 - x2/n2                        the observed difference
 *   p  = (x1 + x2) / (n1 + n2)                pooled rate
 *   V  = p (1 - p) (1/n1 + 1/n2)              Var(d) under H0: difference = 0
 * </pre>
 *
 * <p>Mixing the alternative over {@code N(0, tau^2)} and integrating gives the two-sided value
 *
 * <pre>
 *   E2 = sqrt(V / (V + tau^2)) * exp( tau^2 d^2 / (2 V (V + tau^2)) )
 * </pre>
 *
 * <p>and, with a half-normal mixture on the positive side only, the one-sided value
 *
 * <pre>
 *   E1 = 2 * Phi( d tau / sqrt(V (V + tau^2)) ) * E2
 * </pre>
 *
 * <p>Everything is computed in logs. The exponent is unbounded, so a large genuine effect overflows
 * a double long before the comparison happens.
 *
 * <h2>tau, and the thing not to do with it</h2>
 *
 * <p>tau is the prior scale of the effect worth reacting to, as an absolute difference in
 * proportions. <b>Validity does not depend on tau; only power does.</b> The e-value is a
 * supermartingale under the null for any fixed tau &gt; 0, so a badly chosen tau costs detection
 * speed and never error control.
 *
 * <p>Which is exactly why tau must not be derived from the data being tested. Fitting tau to the
 * observed effect at look t makes the "constant" a function of the sample, the supermartingale
 * property is lost, and the guarantee above evaporates while every number on the screen still looks
 * respectable. Configure it; do not compute it.
 */
public final class MixtureSequentialTest {

    /** Returned when the inputs cannot support a comparison. Never rejects: ln(1) = 0. */
    public static final double NO_EVIDENCE = 0.0;

    private MixtureSequentialTest() {
    }

    /**
     * Log of the one-sided e-value against the null that the two rates are equal, sensitive to the
     * challenger's rate being <em>higher</em> than the baseline's.
     *
     * <p>This is the form the monitor wants in both directions: a degradation is "the challenger
     * errors more", and an improvement is "the challenger converts more". Passing the metric that
     * way round in each case keeps the test one-sided, which is roughly twice as powerful as the
     * two-sided form against the alternative that actually matters.
     *
     * @param variantHits successes (errors, or conversions) for the challenger
     * @param variantSubjects distinct subjects exposed to the challenger
     * @param baselineHits successes for the baseline
     * @param baselineSubjects distinct subjects exposed to the baseline
     * @param tau prior scale of the effect worth detecting, an absolute proportion difference
     * @return {@code ln(E)}, or {@link #NO_EVIDENCE} when the inputs cannot support a comparison
     */
    public static double logEValueOneSided(
        long variantHits, long variantSubjects,
        long baselineHits, long baselineSubjects,
        double tau) {

        Inputs inputs = Inputs.of(variantHits, variantSubjects, baselineHits, baselineSubjects, tau);
        if (inputs == null) {
            return NO_EVIDENCE;
        }
        double scaled = inputs.difference * tau / Math.sqrt(inputs.variance * inputs.shifted);
        return Math.log(2.0) + Gaussian.logCdf(scaled) + logEValueTwoSided(inputs);
    }

    /**
     * Log of the two-sided e-value: sensitive to a difference in either direction. Exposed mostly
     * for tests and for anything that wants "these arms differ" rather than a signed claim.
     */
    public static double logEValueTwoSided(
        long variantHits, long variantSubjects,
        long baselineHits, long baselineSubjects,
        double tau) {

        Inputs inputs = Inputs.of(variantHits, variantSubjects, baselineHits, baselineSubjects, tau);
        return inputs == null ? NO_EVIDENCE : logEValueTwoSided(inputs);
    }

    private static double logEValueTwoSided(Inputs inputs) {
        double shrinkage = 0.5 * (Math.log(inputs.variance) - Math.log(inputs.shifted));
        double growth = inputs.tauSquared * inputs.difference * inputs.difference
            / (2.0 * inputs.variance * inputs.shifted);
        return shrinkage + growth;
    }

    /**
     * The always-valid p-value, {@code min(1, 1 / sup E)}.
     *
     * <p>The argument must be the running <em>supremum</em> of the log e-value over every look so
     * far, not the latest one. Feeding it the latest value produces a number that wanders back up
     * after evidence peaks, which is not a p-value and would let an acknowledged finding quietly
     * un-justify itself.
     */
    public static double alwaysValidP(double logSupremumEValue) {
        if (!Double.isFinite(logSupremumEValue)) {
            return logSupremumEValue > 0 ? 0.0 : 1.0;
        }
        return Math.min(1.0, Math.exp(-logSupremumEValue));
    }

    /** The rejection boundary in log space for a bare Ville test at {@code alpha}. */
    public static double logThreshold(double alpha) {
        return -Math.log(alpha);
    }

    /** Pooled-variance intermediates, or null when no comparison is possible. */
    private static final class Inputs {
        private final double difference;
        private final double variance;
        private final double tauSquared;
        private final double shifted;

        private Inputs(double difference, double variance, double tauSquared) {
            this.difference = difference;
            this.variance = variance;
            this.tauSquared = tauSquared;
            this.shifted = variance + tauSquared;
        }

        private static Inputs of(long x1, long n1, long x2, long n2, double tau) {
            if (n1 < 1 || n2 < 1 || x1 < 0 || x2 < 0 || x1 > n1 || x2 > n2) {
                return null;
            }
            if (!(tau > 0) || !Double.isFinite(tau)) {
                return null;
            }
            double pooled = (double) (x1 + x2) / (double) (n1 + n2);
            double variance = pooled * (1.0 - pooled) * (1.0 / n1 + 1.0 / n2);
            // Zero variance means every subject in both arms did the same thing. There is no
            // evidence of a difference in that case even when the rates are 0 and 1, because the
            // normal approximation the whole statistic rests on has nothing to stand on.
            if (!(variance > 0) || !Double.isFinite(variance)) {
                return null;
            }
            return new Inputs((double) x1 / n1 - (double) x2 / n2, variance, tau * tau);
        }
    }
}
