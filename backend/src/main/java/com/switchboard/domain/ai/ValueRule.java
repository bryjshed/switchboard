package com.switchboard.domain.ai;

import java.util.List;

/** A proposed targeting rule. Rule ids are minted at apply time. */
public record ValueRule(String description, List<ValueClause> clauses, ValueServe serve) {

    public ValueRule {
        clauses = clauses == null ? List.of() : List.copyOf(clauses);
    }
}
