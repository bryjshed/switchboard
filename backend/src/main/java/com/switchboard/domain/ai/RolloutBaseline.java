package com.switchboard.domain.ai;

import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.WeightedVariation;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Picks which variation is the control arm, from configuration alone.
 *
 * <h2>Why not the arm with the most traffic</h2>
 *
 * <p>That was the previous rule, and it is a subtle but real defect. Choosing the baseline by
 * observed volume makes the control a function of the same random variation being tested: under a
 * 50/50 split with identical true rates, the arm selected is systematically the one that happened
 * to receive more traffic this window. Every downstream comparison then inherits that selection,
 * and the test is no longer measuring what it claims to.
 *
 * <p>The configured weights are fixed for the whole epoch by construction - a weight change starts
 * a new epoch - so picking from them is stable, reproducible from the audit trail, and independent
 * of the outcomes. Ties break on variation id so the choice does not wander between scans.
 */
public final class RolloutBaseline {

    private RolloutBaseline() {
    }

    /**
     * The control arm: the largest-weighted variation in the fallthrough rollout, and on a tie the
     * flag's off variation.
     *
     * <h2>Why the tie-break is not arbitrary</h2>
     *
     * <p>An even split has no largest weight, and an even split is the single most common shape a
     * canary takes. Breaking that tie on variation id looks harmless and is not: variation ids are
     * random UUIDs, so the control arm would be chosen by coin flip on every deployment. Half the
     * time the <em>degraded</em> arm becomes the baseline, the one-sided test then asks whether the
     * healthy arm is worse than the broken one, and the answer is correctly "no" - so a real
     * regression goes unreported, non-deterministically. That is a far worse failure than a
     * mis-chosen control, because nothing about it looks wrong.
     *
     * <p>{@code offVariationId} is the flag's declared safe value - what it serves when switched
     * off - which is the best statement the configuration makes about which arm is the incumbent.
     * When it is not one of the tied arms there is nothing left to appeal to, and the lowest
     * variation id keeps the choice at least stable across scans within an epoch.
     *
     * @return empty when the fallthrough is a fixed variation rather than a rollout, which means
     *     there is nothing being split and nothing to compare
     */
    public static Optional<UUID> pick(TargetingConfig config) {
        if (config == null || config.fallthrough() == null) {
            return Optional.empty();
        }
        RolloutOrVariation fallthrough = config.fallthrough();
        if (!fallthrough.hasRollout()) {
            return Optional.empty();
        }
        List<WeightedVariation> live = fallthrough.rollout().stream()
            .filter(weighted -> weighted.weight() > 0)
            .toList();
        if (live.isEmpty()) {
            return Optional.empty();
        }
        int heaviest = live.stream().mapToInt(WeightedVariation::weight).max().orElse(0);
        List<UUID> tied = live.stream()
            .filter(weighted -> weighted.weight() == heaviest)
            .map(WeightedVariation::variationId)
            .toList();

        if (tied.size() == 1) {
            return Optional.of(tied.get(0));
        }
        if (tied.contains(config.offVariationId())) {
            return Optional.of(config.offVariationId());
        }
        return tied.stream().min(Comparator.naturalOrder());
    }

    /** The fallthrough rollout weights, or an empty list when the fallthrough is not a rollout. */
    public static List<WeightedVariation> allocation(TargetingConfig config) {
        if (config == null || config.fallthrough() == null || !config.fallthrough().hasRollout()) {
            return List.of();
        }
        return config.fallthrough().rollout();
    }
}
