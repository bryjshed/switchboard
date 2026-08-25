package com.switchboard.domain.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.WeightedVariation;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class RolloutBaselineTest {

    private static final UUID CONTROL = UUID.fromString("00000000-0000-0000-0000-0000000000c0");
    private static final UUID TREATMENT = UUID.fromString("00000000-0000-0000-0000-0000000000f1");
    private static final UUID THIRD = UUID.fromString("00000000-0000-0000-0000-0000000000a2");

    @Test
    @DisplayName("the heaviest arm is the baseline")
    void heaviestWins() {
        assertThat(RolloutBaseline.pick(rollout(CONTROL, weight(CONTROL, 75), weight(TREATMENT, 25))))
            .contains(CONTROL);
        // Independent of declaration order, and independent of which arm is the off variation.
        assertThat(RolloutBaseline.pick(rollout(TREATMENT, weight(TREATMENT, 10), weight(CONTROL, 90))))
            .contains(CONTROL);
    }

    @Test
    @DisplayName("an even split falls back to the off variation, not to a coin flip")
    void evenSplitUsesTheOffVariation() {
        // This is the case that matters. An even split is the most common canary shape and has no
        // heaviest arm, so a tie-break on variation id would pick the control by random UUID -
        // meaning half the time the degraded arm becomes the baseline, the one-sided test asks
        // whether the healthy arm is worse than the broken one, and a real regression silently
        // goes unreported. It is deterministic here whichever way the ids happen to sort.
        assertThat(RolloutBaseline.pick(rollout(CONTROL, weight(CONTROL, 50), weight(TREATMENT, 50))))
            .contains(CONTROL);
        assertThat(RolloutBaseline.pick(rollout(TREATMENT, weight(CONTROL, 50), weight(TREATMENT, 50))))
            .contains(TREATMENT);
    }

    @Test
    @DisplayName("a three-way tie still resolves to the off variation")
    void threeWayTie() {
        assertThat(RolloutBaseline.pick(rollout(THIRD,
            weight(CONTROL, 34), weight(TREATMENT, 33), weight(THIRD, 33))))
            .contains(CONTROL);
        assertThat(RolloutBaseline.pick(rollout(THIRD,
            weight(CONTROL, 33), weight(TREATMENT, 33), weight(THIRD, 34))))
            .contains(THIRD);
    }

    @Test
    @DisplayName("with the off variation outside the split, the choice is at least stable")
    void tieWithNoOffVariationAmongTheArms() {
        // Nothing left to appeal to, so the lowest id wins - arbitrary, but the same on every scan
        // within an epoch, which is what the statistic needs.
        UUID picked = RolloutBaseline.pick(
            rollout(THIRD, weight(CONTROL, 50), weight(TREATMENT, 50))).orElseThrow();
        assertThat(picked).isEqualTo(CONTROL);
        for (int i = 0; i < 20; i++) {
            assertThat(RolloutBaseline.pick(rollout(THIRD, weight(TREATMENT, 50), weight(CONTROL, 50))))
                .contains(picked);
        }
    }

    @Test
    @DisplayName("zero-weight arms cannot be the baseline")
    void zeroWeightArmsAreExcluded() {
        assertThat(RolloutBaseline.pick(rollout(THIRD,
            weight(CONTROL, 60), weight(TREATMENT, 40), weight(THIRD, 0))))
            .contains(CONTROL);
    }

    @Test
    @DisplayName("a fixed fallthrough is not a rollout and has no baseline")
    void fixedFallthroughHasNoBaseline() {
        TargetingConfig fixed = new TargetingConfig(
            List.of(), List.of(), RolloutOrVariation.ofVariation(CONTROL), CONTROL, TREATMENT);
        assertThat(RolloutBaseline.pick(fixed)).isEmpty();
        assertThat(RolloutBaseline.allocation(fixed)).isEmpty();
        assertThat(RolloutBaseline.pick(null)).isEmpty();
    }

    @Test
    @DisplayName("allocation returns the configured weights")
    void allocationReturnsWeights() {
        assertThat(RolloutBaseline.allocation(
            rollout(CONTROL, weight(CONTROL, 70), weight(TREATMENT, 30))))
            .extracting(WeightedVariation::weight)
            .containsExactly(70, 30);
    }

    private static WeightedVariation weight(UUID variationId, int weight) {
        return new WeightedVariation(variationId, weight);
    }

    private static TargetingConfig rollout(UUID offVariationId, WeightedVariation... weights) {
        return new TargetingConfig(
            List.of(), List.of(),
            RolloutOrVariation.ofRollout(List.of(weights)),
            offVariationId,
            weights[weights.length - 1].variationId());
    }
}
