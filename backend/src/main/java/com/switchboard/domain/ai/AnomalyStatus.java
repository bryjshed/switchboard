package com.switchboard.domain.ai;

/** Lifecycle of a rollout-monitor finding. */
public enum AnomalyStatus {
    OPEN,
    ACKED,
    AUTO_ROLLED_BACK
}
