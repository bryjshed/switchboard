package com.switchboard.domain.evaluation;

import com.switchboard.domain.flag.ClauseOp;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;

/**
 * Comparing one attribute against one clause's values.
 *
 * <p>Split out of {@link FlagEvaluator} because this is now the bulk of the behaviour and all of the
 * fiddly parts: coercion, semver, instants and the regex subset. The evaluator stays a readable
 * precedence ladder; the type rules live here, next to the spec section that defines them
 * ({@code spec/evaluation.md} 3.2).
 *
 * <p>Everything here is pure and total. Nothing throws: a value that cannot be read as the operator
 * needs makes the clause <b>false</b>, never an error. A flag system that can fail a request because
 * somebody typed a bad number into a rule is worse than one that quietly does not match.
 */
public final class ClauseMatcher {

    private ClauseMatcher() {
    }

    /**
     * True when {@code attribute} relates to any of {@code values} under {@code op}.
     *
     * <p>Doubly existential: any element of an array attribute against any listed value. A null
     * attribute - the missing-attribute case - is always false here; negation is applied by the
     * caller, on the result.
     */
    public static boolean matches(ClauseOp op, AttributeValue attribute, List<String> values) {
        if (attribute == null || values == null || values.isEmpty()) {
            return false;
        }
        for (AttributeValue element : attribute.elements()) {
            for (String value : values) {
                if (matchesOne(op, element, value)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean matchesOne(ClauseOp op, AttributeValue attribute, String value) {
        return switch (op) {
            case EQUALS, IN -> text(attribute, value, String::equals);
            case CONTAINS -> text(attribute, value, String::contains);
            case STARTS_WITH -> text(attribute, value, String::startsWith);
            case ENDS_WITH -> text(attribute, value, String::endsWith);
            case MATCHES -> RegexSupport.matches(attribute.asText(), value);

            case GREATER_THAN -> number(attribute, value, comparison -> comparison > 0);
            case GREATER_THAN_OR_EQUAL -> number(attribute, value, comparison -> comparison >= 0);
            case LESS_THAN -> number(attribute, value, comparison -> comparison < 0);
            case LESS_THAN_OR_EQUAL -> number(attribute, value, comparison -> comparison <= 0);

            case BEFORE -> instant(attribute, value, comparison -> comparison < 0);
            case AFTER -> instant(attribute, value, comparison -> comparison > 0);

            case SEMVER_EQUAL -> semver(attribute, value, comparison -> comparison == 0);
            case SEMVER_GREATER_THAN -> semver(attribute, value, comparison -> comparison > 0);
            case SEMVER_LESS_THAN -> semver(attribute, value, comparison -> comparison < 0);

            // Handled by the evaluator, which has the segment map. Reaching here would be a bug,
            // and false is the safe answer to a question this class cannot see the data for.
            case SEGMENT_MATCH, NOT_SEGMENT_MATCH -> false;
        };
    }

    private interface TextTest {
        boolean test(String attribute, String value);
    }

    private interface Ordering {
        boolean holds(int comparison);
    }

    /** An array attribute has no single text, so it can never satisfy a text operator directly. */
    private static boolean text(AttributeValue attribute, String value, TextTest test) {
        String text = attribute.asText();
        return text != null && test.test(text, value);
    }

    private static boolean number(AttributeValue attribute, String value, Ordering ordering) {
        Double left = attribute.asNumber();
        Double right = parseNumber(value);
        return left != null && right != null && ordering.holds(Double.compare(left, right));
    }

    private static boolean instant(AttributeValue attribute, String value, Ordering ordering) {
        Instant left = parseInstant(attribute);
        Instant right = parseInstant(AttributeValue.of(value));
        return left != null && right != null && ordering.holds(left.compareTo(right));
    }

    private static boolean semver(AttributeValue attribute, String value, Ordering ordering) {
        Semver left = Semver.parse(attribute.asText());
        Semver right = Semver.parse(value);
        return left != null && right != null && ordering.holds(left.compareTo(right));
    }

    private static Double parseNumber(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            double parsed = Double.parseDouble(text.trim());
            return Double.isFinite(parsed) ? parsed : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * An instant from ISO-8601 text, or from a number read as epoch milliseconds.
     *
     * <p>Both forms are accepted because both are what applications actually hold: a timestamp from
     * JSON is usually ISO text, and one from a clock is usually milliseconds. Requiring one would
     * push the conversion into every caller for no benefit.
     */
    private static Instant parseInstant(AttributeValue value) {
        if (value == null) {
            return null;
        }
        Double epochMillis = value instanceof AttributeValue.Num num ? num.value() : null;
        if (epochMillis != null) {
            return Instant.ofEpochMilli((long) (double) epochMillis);
        }
        String text = value.asText();
        if (text == null || text.isBlank()) {
            return null;
        }
        String trimmed = text.trim();
        try {
            return OffsetDateTime.parse(trimmed).toInstant();
        } catch (DateTimeException ignored) {
            // Not an offset date-time; fall through to the other accepted forms.
        }
        try {
            return Instant.parse(trimmed);
        } catch (DateTimeException ignored) {
            // Not ISO instant text either.
        }
        Double asNumber = parseNumber(trimmed);
        return asNumber == null ? null : Instant.ofEpochMilli((long) (double) asNumber);
    }
}
