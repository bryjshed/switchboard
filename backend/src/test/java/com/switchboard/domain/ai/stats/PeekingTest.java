package com.switchboard.domain.ai.stats;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Random;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The regression test for the defect this whole package exists to fix.
 *
 * <p>Both halves matter, and the second is what gives the first its meaning. A statistic that never
 * fires would pass {@link #theMixtureTestSurvivesRepeatedPeeking()} trivially; asserting that the
 * old rule <em>fails</em> the identical simulation is what proves the simulation can detect the
 * problem at all. It also leaves an executable record of why the fixed-horizon z-test was demoted,
 * so nobody restores it as a simplification.
 *
 * <p><b>Determinism.</b> {@link Random} with a literal seed. Its linear congruential generator is
 * specified in the Javadoc and reproduces bit-for-bit across JVM vendors and versions.
 * {@code ThreadLocalRandom}, {@code Math.random()} and {@code RandomGenerator.getDefault()} are all
 * free to differ between runs and must never appear in a test that asserts a rate.
 *
 * <p>The bounds below are set with slack around rates actually observed at this seed, not derived
 * from theory alone - a bound derived only from theory tends to fail the first time the arithmetic
 * changes in a way that is entirely correct.
 */
class PeekingTest {

    private static final long SEED = 20_260_824L;
    private static final int TRIALS = 2_000;
    /** One 48-hour rollout scanned hourly - the cadence the monitor actually runs at. */
    private static final int PEEKS = 48;
    private static final int SUBJECTS_PER_PEEK = 100;
    private static final double BASE_RATE = 0.05;
    private static final double ALPHA = 0.01;
    private static final double TAU = 0.02;

    /** A decision rule under test: does it fire on these accumulated counts? */
    private interface Rule {
        boolean fires(long variantHits, long variantSubjects, long baselineHits, long baselineSubjects);
    }

    /** The one-sided normal tail at z &gt; 3: what the old rule's error rate was supposed to be. */
    private static final double Z_TEST_NOMINAL_RATE = 0.00135;

    @Test
    @DisplayName("the mixture test holds its error rate across 48 looks at A/A traffic")
    void theMixtureTestSurvivesRepeatedPeeking() {
        double rate = falsePositiveRate((x1, n1, x2, n2) ->
            MixtureSequentialTest.logEValueOneSided(x1, n1, x2, n2, TAU)
                >= MixtureSequentialTest.logThreshold(ALPHA));

        // Ville bounds this by ALPHA no matter how many looks are taken. Measured 0.0025 at this
        // seed - comfortably under, as a mixture test is designed to be. Asserting against ALPHA
        // itself rather than a padded number, because ALPHA is the bound that actually means
        // something and there is roughly 6 Monte-Carlo standard errors of room beneath it.
        assertThat(rate)
            .as("false positive rate across %d peeks at A/A traffic (measured 0.0025)", PEEKS)
            .isLessThanOrEqualTo(ALPHA);
    }

    @Test
    @DisplayName("the fixed-horizon z-test does NOT hold its error rate across the same 48 looks")
    void theFixedHorizonZTestFailsTheSameSimulation() {
        double rate = falsePositiveRate((x1, n1, x2, n2) ->
            TwoProportionZ.zScore(x1, n1, x2, n2) > 3.0);

        // Measured 0.0090 at this seed against a nominal 0.00135 - about 6.7x the error rate the
        // threshold advertises, on traffic where both arms are identical by construction. Each arm
        // reaches 4,800 subjects here; the inflation grows with the number of looks, and the real
        // monitor looks every hour for as long as a rollout lasts, not 48 times.
        //
        // This is the defect, asserted rather than described. Both halves of this pair matter: a
        // statistic that never fires would pass the sibling test trivially, and this is what shows
        // the simulation can detect the problem it claims the mixture test avoids.
        assertThat(rate)
            .as("the old rule's false positive rate across %d peeks (measured 0.0090)", PEEKS)
            .isGreaterThan(3 * Z_TEST_NOMINAL_RATE);

        // Stated as the comparison that matters: each rule against its own advertised level.
        double mixtureRate = falsePositiveRate((x1, n1, x2, n2) ->
            MixtureSequentialTest.logEValueOneSided(x1, n1, x2, n2, TAU)
                >= MixtureSequentialTest.logThreshold(ALPHA));
        assertThat(rate / Z_TEST_NOMINAL_RATE)
            .as("the old rule overshoots its own level by more than the mixture test overshoots its")
            .isGreaterThan(mixtureRate / ALPHA);
    }

    @Test
    @DisplayName("holding the error rate has not made the test deaf to a real degradation")
    void aRealDegradationIsStillDetectedQuickly() {
        Random rng = new Random(SEED);
        int detected = 0;
        long totalPeeksToDetect = 0;
        int trials = 500;

        for (int trial = 0; trial < trials; trial++) {
            long variantHits = 0;
            long variantSubjects = 0;
            long baselineHits = 0;
            long baselineSubjects = 0;
            for (int peek = 0; peek < PEEKS; peek++) {
                for (int i = 0; i < SUBJECTS_PER_PEEK; i++) {
                    variantSubjects++;
                    // Treatment errors at 10% against a 5% baseline: the kind of regression the
                    // healing loop exists to catch.
                    if (rng.nextDouble() < 0.10) {
                        variantHits++;
                    }
                    baselineSubjects++;
                    if (rng.nextDouble() < BASE_RATE) {
                        baselineHits++;
                    }
                }
                double logE = MixtureSequentialTest.logEValueOneSided(
                    variantHits, variantSubjects, baselineHits, baselineSubjects, TAU);
                if (logE >= MixtureSequentialTest.logThreshold(ALPHA)) {
                    detected++;
                    totalPeeksToDetect += peek + 1;
                    break;
                }
            }
        }

        double power = (double) detected / trials;
        double meanPeeks = (double) totalPeeksToDetect / Math.max(1, detected);

        // A correction that suppressed everything would pass the two tests above and be useless.
        assertThat(power).as("power against a 5%% -> 10%% error regression").isGreaterThan(0.95);
        assertThat(meanPeeks).as("mean hours to detection").isLessThan(12.0);
    }

    /**
     * The fraction of null trials in which the rule fires at least once across {@link #PEEKS}
     * looks. Both arms draw from the same rate, so every firing is a false positive.
     */
    private static double falsePositiveRate(Rule rule) {
        Random rng = new Random(SEED);
        int fired = 0;
        for (int trial = 0; trial < TRIALS; trial++) {
            long variantHits = 0;
            long variantSubjects = 0;
            long baselineHits = 0;
            long baselineSubjects = 0;
            boolean hit = false;
            for (int peek = 0; peek < PEEKS && !hit; peek++) {
                for (int i = 0; i < SUBJECTS_PER_PEEK; i++) {
                    variantSubjects++;
                    if (rng.nextDouble() < BASE_RATE) {
                        variantHits++;
                    }
                    baselineSubjects++;
                    if (rng.nextDouble() < BASE_RATE) {
                        baselineHits++;
                    }
                }
                hit = rule.fires(variantHits, variantSubjects, baselineHits, baselineSubjects);
            }
            if (hit) {
                fired++;
            }
        }
        return (double) fired / TRIALS;
    }
}
