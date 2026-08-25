package com.switchboard.domain.ai.stats;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class GaussianTest {

    @Test
    @DisplayName("the CDF matches tabulated values")
    void cdfMatchesTables() {
        assertThat(Gaussian.cdf(0.0)).isCloseTo(0.5, within(1e-7));
        assertThat(Gaussian.cdf(1.0)).isCloseTo(0.8413447, within(1e-6));
        assertThat(Gaussian.cdf(1.96)).isCloseTo(0.9750021, within(1e-6));
        assertThat(Gaussian.cdf(-1.96)).isCloseTo(0.0249979, within(1e-6));
        assertThat(Gaussian.cdf(3.0)).isCloseTo(0.9986501, within(1e-6));
        // The one-sided tail at z > 3, which is what the old fixed-horizon rule used as its
        // threshold. Quoted in the peeking test as the nominal rate it fails to hold to.
        assertThat(1 - Gaussian.cdf(3.0)).isCloseTo(0.0013499, within(1e-6));
    }

    @Test
    @DisplayName("the CDF is symmetric")
    void cdfIsSymmetric() {
        for (double x = 0.1; x < 6; x += 0.37) {
            assertThat(Gaussian.cdf(x) + Gaussian.cdf(-x))
                .as("cdf(%s) + cdf(-%s)", x, x)
                .isCloseTo(1.0, within(1e-6));
        }
    }

    @Test
    @DisplayName("logCdf agrees with log(cdf) where both are computable")
    void logCdfAgreesWithDirectLog() {
        for (double x = -7.5; x < 3; x += 0.5) {
            assertThat(Gaussian.logCdf(x))
                .as("logCdf(%s)", x)
                .isCloseTo(Math.log(Gaussian.cdf(x)), within(1e-5));
        }
    }

    @Test
    @DisplayName("logCdf stays finite past the point where the CDF underflows")
    void logCdfSurvivesTheFarLeftTail() {
        // log(cdf(-50)) is -inf in doubles. An infinity here would poison a log e-value rather
        // than merely making it small, so the asymptotic branch has to hold.
        assertThat(Math.log(Gaussian.cdf(-50))).isNegative().isInfinite();
        assertThat(Gaussian.logCdf(-50)).isFinite().isLessThan(-1000);
        assertThat(Gaussian.logCdf(-20)).isFinite();
        // Monotone decreasing all the way down.
        assertThat(Gaussian.logCdf(-20)).isGreaterThan(Gaussian.logCdf(-30));
        assertThat(Gaussian.logCdf(-30)).isGreaterThan(Gaussian.logCdf(-50));
    }

    @Test
    @DisplayName("the asymptotic branch agrees with the direct one wherever both are computable")
    void theBranchesAgreeBelowTheCrossover() {
        // Below -8 logCdf switches formulas, but log(cdf(x)) stays computable down to about -39
        // before underflowing. Across that overlap the two must agree, or the crossover is a step
        // change in the e-value caused by nothing but which formula ran.
        //
        // Comparing logCdf(-8.001) against logCdf(-7.999) instead would prove nothing: the slope
        // there is about -x, so those two points legitimately differ by ~0.016 regardless.
        for (double x = -8.0; x > -38.0; x -= 1.5) {
            assertThat(Gaussian.logCdf(x))
                .as("asymptotic logCdf(%s) vs log(cdf(%s))", x, x)
                .isCloseTo(Math.log(Gaussian.cdf(x)), within(1e-4));
        }
    }
}
