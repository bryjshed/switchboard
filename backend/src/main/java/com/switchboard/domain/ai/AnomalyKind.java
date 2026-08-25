package com.switchboard.domain.ai;

/** What a finding is claiming. */
public enum AnomalyKind {
    /** A challenger is doing worse than the baseline on an error metric. */
    DEGRADATION,
    /** A challenger is doing better than the baseline on a conversion metric. */
    IMPROVEMENT,
    /**
     * Traffic is not arriving in the proportions the rollout configured, so the arms are not
     * comparable populations and every rate comparison for this flag is confounded. Carries no
     * proposal: there is nothing safe to automate about a broken randomizer.
     */
    SRM
}
