package com.switchboard.domain.segment;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record Segment(
    UUID id,
    UUID projectId,
    String key,
    String name,
    List<String> includedKeys,
    List<String> excludedKeys,
    List<SegmentRule> rules,
    Instant updatedAt) {

    public Segment {
        includedKeys = includedKeys == null ? List.of() : List.copyOf(includedKeys);
        excludedKeys = excludedKeys == null ? List.of() : List.copyOf(excludedKeys);
        rules = rules == null ? List.of() : List.copyOf(rules);
    }
}
