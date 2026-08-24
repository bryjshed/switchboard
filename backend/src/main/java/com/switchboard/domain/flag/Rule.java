package com.switchboard.domain.flag;

import java.util.List;
import java.util.UUID;

public record Rule(UUID id, String description, List<Clause> clauses, RolloutOrVariation serve) {

    public Rule {
        if (id == null) {
            throw new IllegalArgumentException("rule id is required");
        }
        if (serve == null) {
            throw new IllegalArgumentException("rule serve is required");
        }
        clauses = clauses == null ? List.of() : List.copyOf(clauses);
    }
}
