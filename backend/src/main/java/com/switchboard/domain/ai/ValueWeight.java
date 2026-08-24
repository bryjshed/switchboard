package com.switchboard.domain.ai;

/** One slice of a proposed percentage rollout, keyed by variation value. */
public record ValueWeight(String variationValue, int weight) {
}
