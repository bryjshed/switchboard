package com.switchboard.domain.segment;

import com.switchboard.domain.flag.Clause;
import java.util.List;

public record SegmentRule(List<Clause> clauses) {

    public SegmentRule {
        clauses = clauses == null ? List.of() : List.copyOf(clauses);
    }
}
