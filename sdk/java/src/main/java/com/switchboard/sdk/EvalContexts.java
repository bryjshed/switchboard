package com.switchboard.sdk;

import com.switchboard.domain.evaluation.AttributeValue;
import com.switchboard.domain.evaluation.EvalContext;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds {@link EvalContext} values without the caller having to know
 * {@link AttributeValue}'s shape.
 *
 * <p>Attribute types are preserved rather than flattened to strings, and that matters: the
 * operator decides how to read both sides, so {@code seats} arriving as a number is what lets
 * {@code GREATER_THAN} compare numerically, and {@code appVersion} arriving as a string is
 * what lets {@code SEMVER_GREATER_THAN} compare as a version.
 *
 * <pre>{@code
 * EvalContexts.builder("user-3").put("plan", "pro").put("seats", 250).build();
 * }</pre>
 */
public final class EvalContexts {

    private EvalContexts() {
    }

    /** A context with a key and no attributes. */
    public static EvalContext of(String key) {
        return new EvalContext(key, Map.of());
    }

    public static Builder builder(String key) {
        return new Builder(key);
    }

    /** Fluent builder for an evaluation context. */
    public static final class Builder {
        private final String key;
        private final Map<String, AttributeValue> attributes = new LinkedHashMap<>();

        private Builder(String key) {
            this.key = key;
        }

        public Builder put(String name, String value) {
            attributes.put(name, new AttributeValue.Str(value));
            return this;
        }

        public Builder put(String name, double value) {
            attributes.put(name, new AttributeValue.Num(value));
            return this;
        }

        public Builder put(String name, boolean value) {
            attributes.put(name, new AttributeValue.Bool(value));
            return this;
        }

        /** A list attribute. Every operator is existential: it matches if ANY element does. */
        public Builder putStrings(String name, List<String> values) {
            List<AttributeValue> wrapped = new ArrayList<>();
            values.forEach(v -> wrapped.add(new AttributeValue.Str(v)));
            attributes.put(name, new AttributeValue.Arr(List.copyOf(wrapped)));
            return this;
        }

        public EvalContext build() {
            return new EvalContext(key, Map.copyOf(attributes));
        }
    }
}
