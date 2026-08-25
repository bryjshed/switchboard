package com.switchboard.domain.evaluation;

import java.util.List;

/**
 * One value in an evaluation context's attribute map.
 *
 * <h2>Why the context is typed and the clause is not</h2>
 *
 * <p>Attributes are typed because that is what the caller actually has: an app version is a string,
 * a cart total is a number, a trial flag is a boolean. Forcing those through {@code String} was the
 * old model, and it is why {@code version >= 4.2.0} was inexpressible.
 *
 * <p>Clause values stay strings on the wire, and that is deliberate rather than unfinished. A rule
 * is authored in a form, stored as JSON, rendered in a table and read in a diff; keeping the
 * comparison value textual keeps all of that legible and keeps the wire format stable. <b>The
 * operator decides how to read both sides</b> - see {@code spec/evaluation.md} section 3.2 - which
 * is one rule to learn instead of a type system to negotiate.
 */
public sealed interface AttributeValue {

    /** A text value. Also what a number or boolean becomes for the string operators. */
    record Str(String value) implements AttributeValue {
    }

    /** A JSON number. Always a double, because JSON has one numeric type. */
    record Num(double value) implements AttributeValue {
    }

    record Bool(boolean value) implements AttributeValue {
    }

    /**
     * A list of values.
     *
     * <p>Every operator is existential over an array: the clause matches when <b>any</b> element
     * matches. That makes {@code roles CONTAINS admin} mean what an author expects when {@code
     * roles} is {@code ["admin","billing"]}, rather than silently stringifying the whole list.
     *
     * <p>Nested arrays are flattened away at the boundary rather than supported: they have no
     * meaning any operator could act on, and pretending otherwise would only produce surprising
     * matches.
     */
    record Arr(List<AttributeValue> values) implements AttributeValue {
        public Arr {
            values = values == null ? List.of() : List.copyOf(values);
        }
    }

    static AttributeValue of(String value) {
        return new Str(value);
    }

    static AttributeValue of(double value) {
        return new Num(value);
    }

    static AttributeValue of(boolean value) {
        return new Bool(value);
    }

    /**
     * The canonical text of this value, for the string operators.
     *
     * <p>An integral number renders without a trailing {@code .0}: an author writing
     * {@code version EQUALS 4} means the number 4, and {@code "4.0"} would not match it. Arrays
     * have no single text and return null - the operators handle them elementwise instead.
     */
    default String asText() {
        return switch (this) {
            case Str str -> str.value();
            case Bool bool -> Boolean.toString(bool.value());
            case Num num -> num.value() == Math.rint(num.value()) && !Double.isInfinite(num.value())
                ? Long.toString((long) num.value())
                : Double.toString(num.value());
            case Arr ignored -> null;
        };
    }

    /**
     * This value as a number, or null when it is not one.
     *
     * <p>A string that parses is accepted, because an attribute arriving from a query string or a
     * header is text even when it means a number, and refusing it would make the numeric operators
     * useless in exactly the places they are most wanted.
     */
    default Double asNumber() {
        return switch (this) {
            case Num num -> num.value();
            case Str str -> parseDouble(str.value());
            case Bool ignored -> null;
            case Arr ignored -> null;
        };
    }

    private static Double parseDouble(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            double parsed = Double.parseDouble(text.trim());
            // NaN and infinities compare unhelpfully - every comparison against NaN is false, which
            // would read as "the rule did not match" rather than "that is not a number".
            return Double.isFinite(parsed) ? parsed : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** The elements to test individually: an array's contents, or just this value. */
    default List<AttributeValue> elements() {
        return this instanceof Arr array ? array.values() : List.of(this);
    }
}
