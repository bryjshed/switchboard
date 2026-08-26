package com.switchboard.domain.flag;

import java.util.UUID;

public record IndividualTarget(String contextKey, UUID variationId) {

    public IndividualTarget {
        if (contextKey == null || contextKey.isBlank()) {
            throw new IllegalArgumentException("target contextKey is required");
        }
        if (variationId == null) {
            throw new IllegalArgumentException("target variationId is required");
        }
    }
}
