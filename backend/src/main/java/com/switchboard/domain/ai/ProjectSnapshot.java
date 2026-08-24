package com.switchboard.domain.ai;

import java.util.List;

/**
 * Everything the assistant is allowed to know about a project when drafting:
 * existing flags (keys, kinds, variation values), segment keys, environment
 * keys, and the context attributes already referenced by existing rules.
 */
public record ProjectSnapshot(
    String projectKey,
    List<FlagSnapshotItem> flags,
    List<String> segmentKeys,
    List<String> envKeys,
    List<String> attributeHints) {

    public ProjectSnapshot {
        flags = flags == null ? List.of() : List.copyOf(flags);
        segmentKeys = segmentKeys == null ? List.of() : List.copyOf(segmentKeys);
        envKeys = envKeys == null ? List.of() : List.copyOf(envKeys);
        attributeHints = attributeHints == null ? List.of() : List.copyOf(attributeHints);
    }
}
