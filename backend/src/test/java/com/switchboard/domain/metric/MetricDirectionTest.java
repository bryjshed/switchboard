package com.switchboard.domain.metric;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Which way is "worse" for each kind of metric.
 *
 * <p>Small, and worth having: getting this backwards would not fail loudly. The monitor would
 * test the opposite hypothesis and report it with full statistical ceremony - an always-valid
 * p-value, an e-BH family size, a rationale in plain English - all of it describing the wrong
 * question. That is the most expensive kind of bug this codebase can have.
 */
class MetricDirectionTest {

    @Test
    @DisplayName("for an error-shaped metric, going UP is the degradation")
    void decreaseIsBetter() {
        MetricDirection errors = MetricDirection.DECREASE_IS_BETTER;
        assertTrue(errors.isDegradation(0.01, 0.05), "more errors is worse");
        assertFalse(errors.isDegradation(0.05, 0.01), "fewer errors is better");
    }

    @Test
    @DisplayName("for a conversion-shaped metric, going DOWN is the degradation")
    void increaseIsBetter() {
        // The blind spot this whole feature closes: before metric definitions existed,
        // conversion was only ever tested for IMPROVEMENT, so a variation that destroyed it was
        // never healed.
        MetricDirection conversions = MetricDirection.INCREASE_IS_BETTER;
        assertTrue(conversions.isDegradation(0.20, 0.05), "converting less is worse");
        assertFalse(conversions.isDegradation(0.05, 0.20), "converting more is better");
    }

    @Test
    @DisplayName("no movement is not a degradation in either direction")
    void equalIsNeutral() {
        assertFalse(MetricDirection.DECREASE_IS_BETTER.isDegradation(0.1, 0.1));
        assertFalse(MetricDirection.INCREASE_IS_BETTER.isDegradation(0.1, 0.1));
    }
}
