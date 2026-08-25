package com.switchboard.domain.ai.stats;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class SampleRatioMismatchTest {

    private static final double C = 1.0;
    /** The gate's threshold: reject when ln E >= -ln(0.001). */
    private static final double THRESHOLD = -Math.log(0.001);

    @Test
    @DisplayName("traffic arriving as configured produces evidence below one")
    void aHealthySplitDoesNotFire() {
        assertThat(SampleRatioMismatch.logEValue(new long[] {500, 500}, new int[] {50, 50}, C))
            .isLessThan(0);
        assertThat(SampleRatioMismatch.logEValue(new long[] {2497, 2503}, new int[] {50, 50}, C))
            .isLessThan(THRESHOLD);
        assertThat(SampleRatioMismatch.logEValue(new long[] {248, 752}, new int[] {25, 75}, C))
            .isLessThan(THRESHOLD);
    }

    @Test
    @DisplayName("a broken randomizer fires hard")
    void a80To20SplitOnA50To50ConfigFires() {
        double logE = SampleRatioMismatch.logEValue(new long[] {800, 200}, new int[] {50, 50}, C);

        assertThat(logE).isGreaterThan(THRESHOLD);
        // Not marginally: this is the case where suppressing the flag's comparisons is obviously
        // right, and the statistic should say so unambiguously.
        assertThat(logE).isGreaterThan(Math.log(1000));
        assertThat(SampleRatioMismatch.pValue(logE)).isLessThan(0.001);
    }

    @Test
    @DisplayName("evidence grows as the mismatch widens")
    void evidenceIsMonotoneInTheImbalance() {
        double previous = Double.NEGATIVE_INFINITY;
        for (long extra = 0; extra <= 300; extra += 50) {
            double logE = SampleRatioMismatch.logEValue(
                new long[] {500 + extra, 500 - extra}, new int[] {50, 50}, C);
            assertThat(logE).as("imbalance +%d", extra).isGreaterThan(previous);
            previous = logE;
        }
    }

    @Test
    @DisplayName("a three-way split is handled")
    void threeWaySplits() {
        assertThat(SampleRatioMismatch.logEValue(
            new long[] {334, 333, 333}, new int[] {34, 33, 33}, C)).isLessThan(THRESHOLD);
        assertThat(SampleRatioMismatch.logEValue(
            new long[] {700, 150, 150}, new int[] {34, 33, 33}, C)).isGreaterThan(THRESHOLD);
    }

    @Test
    @DisplayName("zero-weight arms are excluded from the allocation being tested")
    void zeroWeightArmsDoNotParticipate() {
        // An arm configured to receive nothing is not part of this allocation. Counting it would
        // report an infinite surprise for what is a different fault entirely.
        double withIdleArm = SampleRatioMismatch.logEValue(
            new long[] {500, 500, 7}, new int[] {50, 50, 0}, C);
        double withoutIt = SampleRatioMismatch.logEValue(
            new long[] {500, 500}, new int[] {50, 50}, C);
        assertThat(withIdleArm).isCloseTo(withoutIt, within(1e-9));
    }

    @Test
    @DisplayName("a single participating arm carries no allocation information")
    void oneArmIsNotATest() {
        assertThat(SampleRatioMismatch.logEValue(new long[] {1000, 0}, new int[] {100, 0}, C))
            .isEqualTo(SampleRatioMismatch.NO_EVIDENCE);
    }

    @Test
    @DisplayName("degenerate inputs return no evidence")
    void degenerateInputsAreSafe() {
        assertThat(SampleRatioMismatch.logEValue(null, new int[] {50, 50}, C))
            .isEqualTo(SampleRatioMismatch.NO_EVIDENCE);
        assertThat(SampleRatioMismatch.logEValue(new long[] {1, 2, 3}, new int[] {50, 50}, C))
            .isEqualTo(SampleRatioMismatch.NO_EVIDENCE);
        assertThat(SampleRatioMismatch.logEValue(new long[] {0, 0}, new int[] {50, 50}, C))
            .isEqualTo(SampleRatioMismatch.NO_EVIDENCE);
        assertThat(SampleRatioMismatch.logEValue(new long[] {500, 500}, new int[] {50, 50}, 0))
            .isEqualTo(SampleRatioMismatch.NO_EVIDENCE);
    }

    @Test
    @DisplayName("concentration selects which size of mismatch the test is powerful against")
    void concentrationSelectsTheAlternativeScale() {
        int[] evenSplit = {50, 50};

        // A concentrated prior puts its alternative near the configured weights, so it is MORE
        // sensitive to subtle drift...
        assertThat(SampleRatioMismatch.logEValue(new long[] {530, 470}, evenSplit, 100.0))
            .isGreaterThan(SampleRatioMismatch.logEValue(new long[] {530, 470}, evenSplit, 1.0));

        // ...and correspondingly LESS sensitive to gross breakage, which it did not expect.
        assertThat(SampleRatioMismatch.logEValue(new long[] {800, 200}, evenSplit, 100.0))
            .isLessThan(SampleRatioMismatch.logEValue(new long[] {800, 200}, evenSplit, 1.0));

        // Which is why the default is c = 1: this gate exists to catch a broken randomizer, not to
        // report allocation drift. Both settings still fire on the gross case by a wide margin.
        assertThat(SampleRatioMismatch.logEValue(new long[] {800, 200}, evenSplit, 100.0))
            .isGreaterThan(THRESHOLD);
    }

    @Test
    @DisplayName("the descriptive chi-square agrees with the e-value on ordering")
    void chiSquareOrdersTheSameWay() {
        // Kept only so an operator can cross-check against tooling that speaks chi-square. It must
        // at least rank the same cases the same way as the statistic that makes the decision.
        double healthyChi = SampleRatioMismatch.chiSquare(new long[] {500, 500}, new int[] {50, 50});
        double brokenChi = SampleRatioMismatch.chiSquare(new long[] {800, 200}, new int[] {50, 50});
        assertThat(healthyChi).isCloseTo(0.0, within(1e-9));
        assertThat(brokenChi).isCloseTo(360.0, within(1e-9));
        assertThat(brokenChi).isGreaterThan(healthyChi);
    }
}
