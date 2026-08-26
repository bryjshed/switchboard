package com.switchboard.domain.evaluation;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Evaluation context: the stable user/entity key plus typed attributes.
 *
 * <p>Attributes were {@code Map<String, String>} until typed attributes landed. They are typed now
 * because that is what callers actually have - an app version is a string, a cart total is a number,
 * a trial flag is a boolean - and flattening all three to text is why numeric and version
 * comparisons were inexpressible.
 */
public record EvalContext(String key, Map<String, AttributeValue> attributes) {

    public EvalContext {
        if (key == null || key.isBlank()) {
            throw new IllegalArgumentException("context key is required");
        }
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /**
     * The all-strings shape, which is still the common case and what every existing caller passes.
     *
     * <p>Kept as a convenience constructor rather than removed: a context whose attributes are all
     * strings is not a legacy context, it is the ordinary one.
     */
    public static EvalContext ofStrings(String key, Map<String, String> attributes) {
        Map<String, AttributeValue> typed = new LinkedHashMap<>();
        if (attributes != null) {
            attributes.forEach((name, value) -> {
                if (value != null) {
                    typed.put(name, AttributeValue.of(value));
                }
            });
        }
        return new EvalContext(key, typed);
    }

    /** The named attribute, or null when it is absent. A missing attribute fails its clause. */
    public AttributeValue attribute(String name) {
        return attributes.get(name);
    }
}
