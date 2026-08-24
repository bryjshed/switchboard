package com.switchboard.domain.ai;

/** The measured degradation the assistant is asked to summarize. */
public record AnomalyInput(
    String flagKey,
    String envKey,
    String variationLabel,
    String baselineLabel,
    String metricKey,
    double baselineRate,
    double variantRate,
    double zScore,
    long variantSamples,
    long baselineSamples) {
}
