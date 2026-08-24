package com.switchboard.domain.flag;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class RolloutOrVariationTest {

    private static final UUID A = UUID.randomUUID();
    private static final UUID B = UUID.randomUUID();

    @Test
    void weightsMustSumToExactly100() {
        assertThrows(IllegalArgumentException.class, () -> RolloutOrVariation.ofRollout(List.of(
            new WeightedVariation(A, 60), new WeightedVariation(B, 30))));
        assertThrows(IllegalArgumentException.class, () -> RolloutOrVariation.ofRollout(List.of(
            new WeightedVariation(A, 60), new WeightedVariation(B, 50))));
        RolloutOrVariation valid = RolloutOrVariation.ofRollout(List.of(
            new WeightedVariation(A, 60), new WeightedVariation(B, 40)));
        assertTrue(valid.hasRollout());
    }

    @Test
    void exactlyOneOfVariationOrRolloutMustBeSet() {
        assertThrows(IllegalArgumentException.class, () -> new RolloutOrVariation(null, null));
        assertThrows(IllegalArgumentException.class, () -> new RolloutOrVariation(null, List.of()));
        assertThrows(IllegalArgumentException.class, () -> new RolloutOrVariation(A, List.of(
            new WeightedVariation(A, 100))));
        assertEquals(A, RolloutOrVariation.ofVariation(A).variationId());
    }

    @Test
    void weightRangeIsValidated() {
        assertThrows(IllegalArgumentException.class, () -> new WeightedVariation(A, -1));
        assertThrows(IllegalArgumentException.class, () -> new WeightedVariation(A, 101));
    }
}
