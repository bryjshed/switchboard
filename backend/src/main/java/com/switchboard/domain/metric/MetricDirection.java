package com.switchboard.domain.metric;

/**
 * Which way is good for a metric.
 *
 * <p>This is what lets the monitor tell a regression from an improvement, which is the entire
 * decision it makes. Before metric definitions existed the answer was implicit in two hard-coded
 * keys - {@code error} could only ever degrade, {@code conversion} could only ever improve - and
 * that implicitness hid a real blind spot: a variation that destroyed conversion was never
 * healed, because conversion was only ever tested for improvement.
 */
public enum MetricDirection {
    /** More is better: conversions, retention, completed checkouts. */
    INCREASE_IS_BETTER,
    /** Less is better: errors, refunds, support contacts, latency breaches. */
    DECREASE_IS_BETTER;

    /**
     * Whether a challenger's proportion moving from {@code baseline} to {@code challenger} is a
     * degradation. The one place the direction is actually interpreted.
     */
    public boolean isDegradation(double baseline, double challenger) {
        return this == INCREASE_IS_BETTER ? challenger < baseline : challenger > baseline;
    }
}
