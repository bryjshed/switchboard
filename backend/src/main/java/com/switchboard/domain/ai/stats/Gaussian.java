package com.switchboard.domain.ai.stats;

/**
 * The normal distribution, to the precision a rollout decision needs and no more.
 *
 * <p>No dependency: this is {@code java.lang.Math} only, which is the point. The alternative was
 * pulling in a statistics library for three functions on the hot path of a scheduled job.
 *
 * <p>The error-function approximation is the Numerical Recipes rational form, fractional error
 * below 1.2e-7 everywhere. That is far tighter than anything here needs - the decision threshold is
 * a log-scale comparison against ln(1/alpha), where alpha is 0.05 or 0.01 - and the error direction
 * is safe besides: an underestimated left tail can only shrink the e-value, and a smaller e-value
 * can only fail to reject.
 */
public final class Gaussian {

    /** Below this the direct log underflows toward -inf; the asymptotic series takes over. */
    private static final double ASYMPTOTIC_THRESHOLD = -8.0;
    private static final double HALF_LOG_TWO_PI = 0.5 * Math.log(2 * Math.PI);
    private static final double INV_SQRT_TWO = 1.0 / Math.sqrt(2.0);

    private Gaussian() {
    }

    /** The complementary error function, erfc(x) = 1 - erf(x). */
    public static double erfc(double x) {
        double z = Math.abs(x);
        double t = 1.0 / (1.0 + 0.5 * z);
        double series = t * Math.exp(-z * z - 1.26551223
            + t * (1.00002368
            + t * (0.37409196
            + t * (0.09678418
            + t * (-0.18628806
            + t * (0.27886807
            + t * (-1.13520398
            + t * (1.48851587
            + t * (-0.82215223
            + t * 0.17087277)))))))));
        return x >= 0.0 ? series : 2.0 - series;
    }

    /** The standard normal CDF. */
    public static double cdf(double x) {
        return 0.5 * erfc(-x * INV_SQRT_TWO);
    }

    /**
     * {@code ln(cdf(x))}, staying finite deep into the left tail.
     *
     * <p>Taking {@code Math.log(cdf(x))} directly collapses to negative infinity once the CDF
     * underflows, around x = -38. That matters because this term is added to a log e-value: an
     * infinity there would poison the comparison rather than simply making it small. Below the
     * threshold the standard asymptotic expansion is used instead, which stays accurate precisely
     * where the direct computation stops being.
     */
    public static double logCdf(double x) {
        if (x > ASYMPTOTIC_THRESHOLD) {
            return Math.log(cdf(x));
        }
        double squared = x * x;
        return -0.5 * squared - Math.log(-x) - HALF_LOG_TWO_PI
            + Math.log1p(-1.0 / squared + 3.0 / (squared * squared));
    }
}
