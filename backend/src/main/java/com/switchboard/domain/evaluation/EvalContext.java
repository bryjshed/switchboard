package com.switchboard.domain.evaluation;

import java.util.Map;

/** Evaluation context: the stable user/entity key plus arbitrary string attributes. */
public record EvalContext(String key, Map<String, String> attributes) {

    public EvalContext {
        if (key == null || key.isBlank()) {
            throw new IllegalArgumentException("context key is required");
        }
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }
}
