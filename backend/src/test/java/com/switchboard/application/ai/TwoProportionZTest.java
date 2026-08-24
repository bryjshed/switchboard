package com.switchboard.application.ai;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class TwoProportionZTest {

    @Test
    void flagsAClearDegradationWellAboveTheThreshold() {
        // 20% errors vs 2% over 200 evaluations each.
        double z = TwoProportionZ.zScore(40, 200, 4, 200);
        assertThat(z).isGreaterThan(3.0);
    }

    @Test
    void staysQuietWhenTheRatesMatch() {
        double z = TwoProportionZ.zScore(10, 200, 10, 200);
        assertThat(z).isZero();
    }

    @Test
    void staysQuietOnTinySamples() {
        // Same 20%-vs-2% gap, but only 10 evaluations a side.
        double z = TwoProportionZ.zScore(2, 10, 0, 10);
        assertThat(z).isLessThan(3.0);
    }

    @Test
    void returnsZeroWhenASideHasNoSamples() {
        assertThat(TwoProportionZ.zScore(0, 0, 5, 100)).isZero();
        assertThat(TwoProportionZ.zScore(5, 100, 0, 0)).isZero();
    }
}
