package com.switchboard.interfaces.rest.mapper;

import com.switchboard.domain.evaluation.AttributeValue;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON attribute values to typed {@link AttributeValue}s.
 *
 * <p>The wire carries whatever JSON the caller sent, so this is the one place that decides what a
 * given JSON shape means to evaluation. Two rules, both chosen so that a surprising input produces
 * a predictable non-match rather than an error or a silent coercion:
 *
 * <ul>
 *   <li><b>null is absence.</b> A null attribute is dropped rather than stored, so it behaves
 *       exactly like an attribute that was never sent. Any other reading would make {@code null}
 *       a value that could match something.
 *   <li><b>Nested objects are dropped; nested arrays are flattened.</b> No operator can act on an
 *       object, and a list of lists has no meaning a rule author could use. Dropping is honest;
 *       stringifying would invent matches.
 * </ul>
 */
public final class AttributeMappers {

    private AttributeMappers() {
    }

    public static Map<String, AttributeValue> toAttributes(Map<String, Object> raw) {
        Map<String, AttributeValue> typed = new LinkedHashMap<>();
        if (raw == null) {
            return typed;
        }
        raw.forEach((name, value) -> {
            AttributeValue converted = toValue(value);
            if (converted != null) {
                typed.put(name, converted);
            }
        });
        return typed;
    }

    /** @return null for anything evaluation cannot act on, which is then treated as absent */
    private static AttributeValue toValue(Object value) {
        return switch (value) {
            case null -> null;
            case String string -> AttributeValue.of(string);
            case Boolean bool -> AttributeValue.of(bool);
            case Number number -> AttributeValue.of(number.doubleValue());
            case Iterable<?> items -> toArray(items);
            // A Map, or anything else: no operator applies, so it is absent rather than an error.
            default -> null;
        };
    }

    private static AttributeValue toArray(Iterable<?> items) {
        List<AttributeValue> values = new ArrayList<>();
        for (Object item : items) {
            AttributeValue converted = toValue(item);
            // A nested array contributes its elements, not itself: the operators are already
            // existential over an array, so flattening keeps that one rule true at any depth.
            if (converted instanceof AttributeValue.Arr nested) {
                values.addAll(nested.values());
            } else if (converted != null) {
                values.add(converted);
            }
        }
        return values.isEmpty() ? null : new AttributeValue.Arr(values);
    }
}
