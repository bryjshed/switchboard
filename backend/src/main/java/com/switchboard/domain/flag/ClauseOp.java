package com.switchboard.domain.flag;

/**
 * How a clause compares a context attribute against its listed values.
 *
 * <p>Every operator is <b>existential over the clause's values</b>: it matches when the attribute
 * relates to <em>any</em> listed value. And every operator is existential over an array-valued
 * attribute too. So {@code roles CONTAINS [admin, owner]} means "any of this context's roles
 * contains either of those strings".
 *
 * <p>Negation is {@link Clause#negate()} rather than a mirrored operator for each of these. Doubling
 * the enum would double the surface a rule editor, a diff view and every SDK have to handle, to
 * express something one boolean already says.
 */
public enum ClauseOp {

    // ---------------------------------------------------------------- text

    /** Exact, case-sensitive. */
    EQUALS,
    /** Identical to {@link #EQUALS}; the name exists for readability when the list has several values. */
    IN,
    CONTAINS,
    STARTS_WITH,
    ENDS_WITH,
    /**
     * Regular expression match.
     *
     * <p>Restricted to a portable subset - no lookaround, no backreferences - so the Java server and
     * a JavaScript SDK cannot disagree about what a pattern means. See
     * {@code spec/evaluation.md} 3.2 and {@code RegexSupport}.
     */
    MATCHES,

    // ---------------------------------------------------------------- numeric

    GREATER_THAN,
    GREATER_THAN_OR_EQUAL,
    LESS_THAN,
    LESS_THAN_OR_EQUAL,

    // ---------------------------------------------------------------- time

    /** The attribute is an instant strictly before the listed one. */
    BEFORE,
    /** The attribute is an instant strictly after the listed one. */
    AFTER,

    // ---------------------------------------------------------------- versions

    SEMVER_EQUAL,
    SEMVER_GREATER_THAN,
    SEMVER_LESS_THAN,

    // ---------------------------------------------------------------- segments

    SEGMENT_MATCH,
    /**
     * Kept as a read-time alias for {@code SEGMENT_MATCH} with {@code negate = true}, so configs
     * written before per-clause negation existed keep evaluating identically. Nothing produces it
     * any more.
     */
    NOT_SEGMENT_MATCH;

    /** True for the operators that ignore {@code attribute} and read {@code values} as segment keys. */
    public boolean isSegmentOp() {
        return this == SEGMENT_MATCH || this == NOT_SEGMENT_MATCH;
    }
}
