package com.switchboard.domain.flag;

import java.util.UUID;

public record Variation(UUID id, String value, String name) {

    public Variation {
        if (id == null) {
            throw new IllegalArgumentException("variation id is required");
        }
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("variation value is required");
        }
    }
}
