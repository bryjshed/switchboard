package com.switchboard.domain.ai;

import java.util.List;

/** A proposed targeting clause; {@code op} mirrors {@link com.switchboard.domain.flag.ClauseOp}. */
public record ValueClause(String attribute, String op, List<String> values) {

    public ValueClause {
        values = values == null ? List.of() : List.copyOf(values);
    }
}
