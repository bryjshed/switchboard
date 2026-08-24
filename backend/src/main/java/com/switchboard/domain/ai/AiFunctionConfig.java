package com.switchboard.domain.ai;

/** Per-function model settings, read from ai_function_configs at call time. */
public record AiFunctionConfig(String functionKey, String modelId, double temperature, int maxTokens, boolean enabled) {
}
