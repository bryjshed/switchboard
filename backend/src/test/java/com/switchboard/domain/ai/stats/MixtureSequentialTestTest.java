package com.switchboard.domain.ai.stats;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class MixtureSequentialTestTest {

    private static final double TAU = 0.02;

    @Test
    @DisplayName("no observed difference yields evidence BELOW one, not at it")
    void identicalRatesGiveEvidenceBelowOne() {
        // E2 = sqrt(V/(V+tau^2)) when d = 0, which is strictly less than 1. Evidence for the null
        // is the correct reading: the arms were measured and did not differ.
        double logE = MixtureSequentialTest.logEValueTwoSided(20, 400, 20, 400, TAU);
        assertThat(logE).isNegative();
        assertThat(Math.exp(logE)).isLessThan(1.0).isGreaterThan(0.0);
    }

    @Test
    @DisplayName("evidence grows with the observed difference")
    void evidenceIsMonotoneInTheDifference() {
        double previous = Double.NEGATIVE_INFINITY;
        for (long variantHits = 20; variantHits <= 120; variantHits += 10) {
            double logE = MixtureSequentialTest.logEValueOneSided(variantHits, 400, 20, 400, TAU);
            assertThat(logE).as("hits=%d", variantHits).isGreaterThan(previous);
            previous = logE;
        }
    }

    @Test
    @DisplayName("the one-sided test ignores a difference in the wrong direction")
    void oneSidedIsDirectional() {
        // Challenger errors far LESS than baseline. That is not a degradation, so the one-sided
        // statistic must not accumulate evidence for one.
        double wrongWay = MixtureSequentialTest.logEValueOneSided(4, 400, 80, 400, TAU);
        double rightWay = MixtureSequentialTest.logEValueOneSided(80, 400, 4, 400, TAU);

        assertThat(wrongWay).isLessThan(0);
        assertThat(rightWay).isGreaterThan(MixtureSequentialTest.logThreshold(0.05));
        assertThat(wrongWay).isLessThan(rightWay);
    }

    @Test
    @DisplayName("the one-sided value is the two-sided value scaled by 2*Phi")
    void oneSidedIsTheTwoSidedValueScaled() {
        long x1 = 60;
        long n1 = 400;
        long x2 = 20;
        long n2 = 400;
        double twoSided = MixtureSequentialTest.logEValueTwoSided(x1, n1, x2, n2, TAU);
        double oneSided = MixtureSequentialTest.logEValueOneSided(x1, n1, x2, n2, TAU);

        double pooled = (double) (x1 + x2) / (n1 + n2);
        double variance = pooled * (1 - pooled) * (1.0 / n1 + 1.0 / n2);
        double difference = (double) x1 / n1 - (double) x2 / n2;
        double scaled = difference * TAU / Math.sqrt(variance * (variance + TAU * TAU));

        assertThat(oneSided - twoSided)
            .isCloseTo(Math.log(2 * Gaussian.cdf(scaled)), within(1e-9));
    }

    @Test
    @DisplayName("as tau approaches zero the evidence approaches one")
    void vanishingTauGivesNoEvidence() {
        // The mixture collapses onto the null itself, so the likelihood ratio tends to 1.
        double logE = MixtureSequentialTest.logEValueTwoSided(60, 400, 20, 400, 1e-9);
        assertThat(Math.exp(logE)).isCloseTo(1.0, within(1e-4));
    }

    @Test
    @DisplayName("tau changes power, not the sign of the conclusion")
    void tauChangesPowerNotValidity() {
        // A real effect is detected at any tau; a bad tau costs speed. This is the property that
        // makes tau safe to configure and unsafe to fit from the data.
        double tight = MixtureSequentialTest.logEValueOneSided(80, 400, 20, 400, 0.005);
        double loose = MixtureSequentialTest.logEValueOneSided(80, 400, 20, 400, 0.20);
        double matched = MixtureSequentialTest.logEValueOneSided(80, 400, 20, 400, 0.15);

        assertThat(tight).isGreaterThan(0);
        assertThat(loose).isGreaterThan(0);
        assertThat(matched).isGreaterThan(0);
    }

    @Test
    @DisplayName("degenerate inputs return no evidence instead of NaN")
    void degenerateInputsAreSafe() {
        assertThat(MixtureSequentialTest.logEValueOneSided(0, 0, 5, 100, TAU))
            .isEqualTo(MixtureSequentialTest.NO_EVIDENCE);
        assertThat(MixtureSequentialTest.logEValueOneSided(5, 100, 0, 0, TAU))
            .isEqualTo(MixtureSequentialTest.NO_EVIDENCE);
        // Zero pooled variance: nobody in either arm did the thing. The normal approximation has
        // nothing to stand on, so this must not read as certainty.
        assertThat(MixtureSequentialTest.logEValueOneSided(0, 500, 0, 500, TAU))
            .isEqualTo(MixtureSequentialTest.NO_EVIDENCE);
        // Every subject did the thing, in both arms. Same reasoning.
        assertThat(MixtureSequentialTest.logEValueOneSided(500, 500, 500, 500, TAU))
            .isEqualTo(MixtureSequentialTest.NO_EVIDENCE);
        assertThat(MixtureSequentialTest.logEValueOneSided(5, 100, 5, 100, 0))
            .isEqualTo(MixtureSequentialTest.NO_EVIDENCE);
        assertThat(MixtureSequentialTest.logEValueOneSided(200, 100, 5, 100, TAU))
            .isEqualTo(MixtureSequentialTest.NO_EVIDENCE);
    }

    @Test
    @DisplayName("the always-valid p-value inverts the supremum")
    void alwaysValidPInvertsTheSupremum() {
        assertThat(MixtureSequentialTest.alwaysValidP(Math.log(100))).isCloseTo(0.01, within(1e-12));
        assertThat(MixtureSequentialTest.alwaysValidP(Math.log(20))).isCloseTo(0.05, within(1e-12));
        // Evidence below 1 cannot produce a p-value above 1.
        assertThat(MixtureSequentialTest.alwaysValidP(Math.log(0.3))).isEqualTo(1.0);
        assertThat(MixtureSequentialTest.alwaysValidP(0)).isEqualTo(1.0);
        assertThat(MixtureSequentialTest.alwaysValidP(Double.POSITIVE_INFINITY)).isEqualTo(0.0);
        assertThat(MixtureSequentialTest.alwaysValidP(Double.NEGATIVE_INFINITY)).isEqualTo(1.0);
    }

    @Test
    @DisplayName("a large effect stays finite in log space")
    void largeEffectsDoNotOverflow() {
        // exp() of this exponent is far past Double.MAX_VALUE, which is exactly why the statistic
        // is never computed outside logs.
        double logE = MixtureSequentialTest.logEValueOneSided(9_000, 100_000, 100, 100_000, 0.02);
        assertThat(logE).isFinite().isGreaterThan(700);
        assertThat(Math.exp(logE)).isInfinite();
        assertThat(MixtureSequentialTest.alwaysValidP(logE)).isEqualTo(0.0);
    }
}
