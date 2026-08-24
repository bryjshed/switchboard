package com.switchboard.domain.flag;

import java.util.List;

public record Clause(String attribute, ClauseOp op, List<String> values) {

    public Clause {
        if (attribute == null || attribute.isBlank()) {
            throw new IllegalArgumentException("clause attribute is required");
        }
        if (op == null) {
            throw new IllegalArgumentException("clause op is required");
        }
        values = values == null ? List.of() : List.copyOf(values);
    }
}
