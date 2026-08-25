package com.switchboard.domain.flag;

import java.util.List;

/**
 * One condition inside a rule. A rule matches when every one of its clauses does.
 *
 * @param negate inverts the clause's result. <b>Including the missing-attribute case</b>: a missing
 *     attribute makes a clause false, so a negated clause on a missing attribute is TRUE. That is
 *     LaunchDarkly's semantics and it is what "release to everyone whose plan is not free" should
 *     mean for somebody with no plan attribute at all - but it surprises people, so it is spelled
 *     out here, in {@code spec/evaluation.md} 3.3, and pinned by conformance vectors.
 */
public record Clause(String attribute, ClauseOp op, List<String> values, boolean negate) {

    public Clause {
        if (attribute == null || attribute.isBlank()) {
            throw new IllegalArgumentException("clause attribute is required");
        }
        if (op == null) {
            throw new IllegalArgumentException("clause op is required");
        }
        values = values == null ? List.of() : List.copyOf(values);
    }

    /** The pre-negation shape, for the many call sites that never needed it. */
    public Clause(String attribute, ClauseOp op, List<String> values) {
        this(attribute, op, values, false);
    }

    /**
     * The operator and negation this clause really means.
     *
     * <p>{@code NOT_SEGMENT_MATCH} predates per-clause negation and is stored in existing configs.
     * Normalising it here - rather than in a migration - means one code path handles both, and a
     * config written years ago still evaluates identically without being rewritten under anyone.
     */
    public Clause normalised() {
        if (op != ClauseOp.NOT_SEGMENT_MATCH) {
            return this;
        }
        return new Clause(attribute, ClauseOp.SEGMENT_MATCH, values, !negate);
    }
}
