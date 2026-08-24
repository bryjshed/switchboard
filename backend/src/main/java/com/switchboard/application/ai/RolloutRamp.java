package com.switchboard.application.ai;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The optimizing ramp: a winning variation moves to the next step of
 * 25 -&gt; 50 -&gt; 75 -&gt; 100 and everyone else is scaled down proportionally.
 * Weights always come out summing to exactly 100, which the domain enforces
 * anyway - doing the correction here means a rounding remainder never turns
 * into a rejected proposal.
 */
public final class RolloutRamp {

    private static final int[] STEPS = {25, 50, 75, 100};

    private RolloutRamp() {
    }

    /** The next step strictly above {@code current}, or 0 when already at the top. */
    public static int nextStep(int current) {
        for (int step : STEPS) {
            if (step > current) {
                return step;
            }
        }
        return 0;
    }

    /**
     * Ramps {@code winner} to {@code target} and scales the rest proportionally.
     * Returns weights in the input's iteration order.
     */
    public static Map<UUID, Integer> ramp(Map<UUID, Integer> weights, UUID winner, int target) {
        int othersTotal = weights.entrySet().stream()
            .filter(entry -> !entry.getKey().equals(winner))
            .mapToInt(Map.Entry::getValue)
            .sum();
        int remaining = 100 - target;

        Map<UUID, Integer> ramped = new LinkedHashMap<>();
        int assigned = 0;
        UUID largestOther = null;
        int largestOtherWeight = -1;
        for (Map.Entry<UUID, Integer> entry : weights.entrySet()) {
            if (entry.getKey().equals(winner)) {
                ramped.put(entry.getKey(), target);
                continue;
            }
            int scaled = othersTotal <= 0 ? 0
                : (int) Math.round((double) entry.getValue() * remaining / othersTotal);
            ramped.put(entry.getKey(), scaled);
            assigned += scaled;
            if (scaled > largestOtherWeight) {
                largestOtherWeight = scaled;
                largestOther = entry.getKey();
            }
        }
        // Absorb the rounding remainder so the weights sum to exactly 100.
        int drift = remaining - assigned;
        if (drift != 0) {
            UUID absorber = largestOther != null ? largestOther : winner;
            ramped.put(absorber, Math.max(0, ramped.get(absorber) + drift));
        }
        return ramped;
    }
}
