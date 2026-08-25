package com.switchboard.domain.ai.stats;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class LogGammaTest {

    @Test
    @DisplayName("lnGamma(n) is ln((n-1)!) at the integers")
    void matchesFactorials() {
        double logFactorial = 0;
        for (int n = 1; n <= 20; n++) {
            assertThat(LogGamma.lnGamma(n))
                .as("lnGamma(%d) == ln(%d!)", n, n - 1)
                .isCloseTo(logFactorial, within(1e-9));
            logFactorial += Math.log(n);
        }
    }

    @Test
    @DisplayName("lnGamma(0.5) is ln(sqrt(pi))")
    void matchesTheHalfIntegerIdentity() {
        assertThat(LogGamma.lnGamma(0.5)).isCloseTo(0.5 * Math.log(Math.PI), within(1e-12));
        // gamma(1.5) = sqrt(pi)/2
        assertThat(LogGamma.lnGamma(1.5))
            .isCloseTo(Math.log(Math.sqrt(Math.PI) / 2), within(1e-12));
    }

    @Test
    @DisplayName("it stays finite at the magnitudes an SRM test reaches")
    void handlesLargeArguments() {
        // gamma(10000) overflows a double many times over; the whole reason the statistic is
        // carried in log space.
        assertThat(LogGamma.lnGamma(10_000)).isFinite().isGreaterThan(80_000);
        assertThat(LogGamma.lnGamma(1e6)).isFinite();
    }

    @Test
    @DisplayName("it refuses non-positive arguments rather than returning NaN")
    void refusesNonPositive() {
        // A NaN here would flow into a log e-value and read as "no evidence", which is a silent
        // wrong answer rather than a loud one.
        assertThatThrownBy(() -> LogGamma.lnGamma(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> LogGamma.lnGamma(-1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> LogGamma.lnGamma(Double.NaN)).isInstanceOf(IllegalArgumentException.class);
    }
}
