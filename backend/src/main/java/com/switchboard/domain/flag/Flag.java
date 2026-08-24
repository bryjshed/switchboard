package com.switchboard.domain.flag;

import java.util.List;
import java.util.UUID;

public record Flag(
    UUID id,
    UUID projectId,
    String key,
    String name,
    String description,
    FlagKind kind,
    List<Variation> variations,
    List<String> tags,
    boolean archived) {

    public Flag {
        variations = variations == null ? List.of() : List.copyOf(variations);
        tags = tags == null ? List.of() : List.copyOf(tags);
    }

    /** The variation with the given id, or null when the id is unknown. */
    public Variation variationById(UUID variationId) {
        if (variationId == null) {
            return null;
        }
        return variations.stream().filter(v -> v.id().equals(variationId)).findFirst().orElse(null);
    }
}
