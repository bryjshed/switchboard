package com.switchboard.domain.ai.stats;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class EBenjaminiHochbergTest {

    private static final double ALPHA = 0.05;

    @Test
    @DisplayName("an empty family rejects nothing")
    void emptyFamily() {
        assertThat(EBenjaminiHochberg.reject(new double[0], ALPHA)).isEmpty();
        assertThat(EBenjaminiHochberg.reject(null, ALPHA)).isEmpty();
    }

    @Test
    @DisplayName("weak evidence everywhere rejects nothing")
    void noRejections() {
        double[] weak = {Math.log(2), Math.log(3), Math.log(1.5)};
        assertThat(EBenjaminiHochberg.reject(weak, ALPHA)).containsOnly(false);
    }

    @Test
    @DisplayName("overwhelming evidence everywhere rejects everything")
    void allRejected() {
        double[] strong = {Math.log(1e6), Math.log(1e7), Math.log(1e8)};
        assertThat(EBenjaminiHochberg.reject(strong, ALPHA)).containsOnly(true);
    }

    @Test
    @DisplayName("a lone strong signal survives alongside weak ones")
    void theStrongestSurvivesAmongNoise() {
        // K = 4, alpha = 0.05. Rank 1 must clear 4/(1*0.05) = 80.
        double[] mixed = {Math.log(1.1), Math.log(500), Math.log(2), Math.log(1.4)};
        boolean[] rejected = EBenjaminiHochberg.reject(mixed, ALPHA);

        assertThat(rejected[1]).as("the strong one").isTrue();
        assertThat(rejected[0]).isFalse();
        assertThat(rejected[2]).isFalse();
        assertThat(rejected[3]).isFalse();
    }

    @Test
    @DisplayName("a signal strong enough alone is suppressed once the family grows")
    void thefamilySizeMatters() {
        // e = 100 clears the single-hypothesis bar of 1/0.05 = 20 comfortably. Put it in a family
        // of ten weak hypotheses and rank 1 must clear 10/(1*0.05) = 200, so it no longer does.
        // This is the correction doing its job: the same evidence means less when it was found by
        // screening more things.
        assertThat(EBenjaminiHochberg.reject(new double[] {Math.log(100)}, ALPHA))
            .containsExactly(true);

        double[] inACrowd = new double[10];
        java.util.Arrays.fill(inACrowd, Math.log(1.2));
        inACrowd[3] = Math.log(100);
        assertThat(EBenjaminiHochberg.reject(inACrowd, ALPHA)).containsOnly(false);
    }

    @Test
    @DisplayName("the threshold is never weaker than a bare Ville test")
    void subsumesTheVilleThreshold() {
        // K/(k*alpha) >= 1/alpha for every k <= K, so e-BH can never reject something that a
        // single-hypothesis test at the same alpha would not. One check, not two.
        for (int familySize = 1; familySize <= 50; familySize++) {
            for (int rank = 1; rank <= familySize; rank++) {
                assertThat(EBenjaminiHochberg.logThreshold(rank, familySize, ALPHA))
                    .as("K=%d k=%d", familySize, rank)
                    .isGreaterThanOrEqualTo(MixtureSequentialTest.logThreshold(ALPHA) - 1e-12);
            }
        }
    }

    @Test
    @DisplayName("the step-up rule admits weaker signals once stronger ones are present")
    void stepUpAdmitsMoreThanTheTopRank() {
        // K = 3, alpha = 0.05: rank 1 needs 60, rank 2 needs 30, rank 3 needs 20. Three values at
        // e = 40 clear rank 2's bar, so the step-up finds k* = 2 and rejects the top two - which a
        // rank-1-only rule would miss entirely.
        double[] values = {Math.log(40), Math.log(40), Math.log(1.1)};
        boolean[] rejected = EBenjaminiHochberg.reject(values, ALPHA);
        assertThat(rejected[0]).isTrue();
        assertThat(rejected[1]).isTrue();
        assertThat(rejected[2]).isFalse();
    }

    @Test
    @DisplayName("the exact boundary rejects and a hair under it does not")
    void boundaryIsInclusive() {
        double exact = EBenjaminiHochberg.logThreshold(1, 1, ALPHA);
        assertThat(EBenjaminiHochberg.reject(new double[] {exact}, ALPHA)).containsExactly(true);
        assertThat(EBenjaminiHochberg.reject(new double[] {exact - 1e-9}, ALPHA))
            .containsExactly(false);
    }

    @Test
    @DisplayName("ties resolve deterministically")
    void tiesAreDeterministic() {
        double[] tied = {Math.log(1000), Math.log(1000), Math.log(1000)};
        boolean[] first = EBenjaminiHochberg.reject(tied, ALPHA);
        for (int i = 0; i < 20; i++) {
            assertThat(EBenjaminiHochberg.reject(tied, ALPHA)).isEqualTo(first);
        }
    }

    @Test
    @DisplayName("an invalid alpha rejects nothing rather than everything")
    void invalidAlphaFailsClosed() {
        double[] strong = {Math.log(1e9)};
        assertThat(EBenjaminiHochberg.reject(strong, 0)).containsOnly(false);
        assertThat(EBenjaminiHochberg.reject(strong, 1)).containsOnly(false);
        assertThat(EBenjaminiHochberg.reject(strong, -0.1)).containsOnly(false);
    }

    @Test
    @DisplayName("the threshold formula is ln(K / (k * alpha))")
    void thresholdFormula() {
        assertThat(EBenjaminiHochberg.logThreshold(1, 4, 0.05))
            .isCloseTo(Math.log(80), within(1e-12));
        assertThat(EBenjaminiHochberg.logThreshold(2, 4, 0.05))
            .isCloseTo(Math.log(40), within(1e-12));
        assertThat(EBenjaminiHochberg.logThreshold(4, 4, 0.05))
            .isCloseTo(Math.log(20), within(1e-12));
    }
}
