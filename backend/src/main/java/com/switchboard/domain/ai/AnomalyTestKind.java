package com.switchboard.domain.ai;

/** Which statistic produced a finding's evidence. */
public enum AnomalyTestKind {
    /**
     * The fixed-horizon two-proportion z-test. Only ever appears on rows written before the
     * anytime-valid rewrite; nothing produces it now. Kept so historical findings still read
     * back rather than failing a check constraint.
     */
    TWO_PROPORTION_Z,
    /** Mixture SPRT on the difference of proportions. The current rate comparison. */
    MSPRT_GAUSSIAN_MIXTURE,
    /** Dirichlet-multinomial e-value on the allocation. The current SRM gate. */
    DIRICHLET_MULTINOMIAL
}
