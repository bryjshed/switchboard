package com.switchboard.domain.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class RolloutRampTest {

    private static final UUID WINNER = UUID.randomUUID();
    private static final UUID OTHER = UUID.randomUUID();
    private static final UUID THIRD = UUID.randomUUID();

    @Test
    void nextStepClimbsTheLadderAndStopsAtTheTop() {
        assertThat(RolloutRamp.nextStep(0)).isEqualTo(25);
        assertThat(RolloutRamp.nextStep(25)).isEqualTo(50);
        assertThat(RolloutRamp.nextStep(50)).isEqualTo(75);
        assertThat(RolloutRamp.nextStep(75)).isEqualTo(100);
        assertThat(RolloutRamp.nextStep(100)).isZero();
        // An off-ladder weight rounds up to the next rung rather than being skipped.
        assertThat(RolloutRamp.nextStep(30)).isEqualTo(50);
    }

    @Test
    void rampsWinnerAndScalesTheRestToExactlyOneHundred() {
        Map<UUID, Integer> weights = new LinkedHashMap<>();
        weights.put(WINNER, 25);
        weights.put(OTHER, 75);

        Map<UUID, Integer> ramped = RolloutRamp.ramp(weights, WINNER, 50);

        assertThat(ramped.get(WINNER)).isEqualTo(50);
        assertThat(ramped.get(OTHER)).isEqualTo(50);
        assertThat(sum(ramped)).isEqualTo(100);
    }

    @Test
    void absorbsRoundingDriftSoWeightsStillSumToOneHundred() {
        Map<UUID, Integer> weights = new LinkedHashMap<>();
        weights.put(WINNER, 34);
        weights.put(OTHER, 33);
        weights.put(THIRD, 33);

        Map<UUID, Integer> ramped = RolloutRamp.ramp(weights, WINNER, 50);

        assertThat(ramped.get(WINNER)).isEqualTo(50);
        assertThat(sum(ramped)).isEqualTo(100);
    }

    @Test
    void rampingToOneHundredZeroesEveryoneElse() {
        Map<UUID, Integer> weights = new LinkedHashMap<>();
        weights.put(WINNER, 75);
        weights.put(OTHER, 25);

        Map<UUID, Integer> ramped = RolloutRamp.ramp(weights, WINNER, 100);

        assertThat(ramped.get(WINNER)).isEqualTo(100);
        assertThat(ramped.get(OTHER)).isZero();
        assertThat(sum(ramped)).isEqualTo(100);
    }

    private static int sum(Map<UUID, Integer> weights) {
        return weights.values().stream().mapToInt(Integer::intValue).sum();
    }
}
