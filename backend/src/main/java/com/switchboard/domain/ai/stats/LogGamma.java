package com.switchboard.domain.ai.stats;

/**
 * {@code ln(gamma(x))} by the Lanczos approximation, g = 7, nine coefficients.
 *
 * <p>Needed only by {@link SampleRatioMismatch}, whose Dirichlet-multinomial e-value is a ratio of
 * gamma functions with arguments as large as the subject count. Computing that ratio directly
 * overflows immediately - {@code gamma(200)} is far past a double - so the whole statistic is
 * carried in log space and this is what makes that possible.
 *
 * <p>Relative accuracy is around 1e-15 for the positive arguments used here, which is better than
 * the statistic needs by many orders of magnitude.
 */
public final class LogGamma {

    private static final double[] COEFFICIENTS = {
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7,
    };

    private static final double G = 7.0;
    private static final double LOG_SQRT_TWO_PI = 0.5 * Math.log(2 * Math.PI);

    private LogGamma() {
    }

    /**
     * @param x strictly positive
     * @throws IllegalArgumentException when x is not positive, rather than returning NaN - a NaN
     *     here would propagate silently into a log e-value and read as "no evidence"
     */
    public static double lnGamma(double x) {
        if (!(x > 0) || !Double.isFinite(x)) {
            throw new IllegalArgumentException("lnGamma requires a positive finite argument, got " + x);
        }
        double z = x - 1.0;
        double series = COEFFICIENTS[0];
        for (int i = 1; i < COEFFICIENTS.length; i++) {
            series += COEFFICIENTS[i] / (z + i);
        }
        double t = z + G + 0.5;
        return LOG_SQRT_TWO_PI + (z + 0.5) * Math.log(t) - t + Math.log(series);
    }
}
