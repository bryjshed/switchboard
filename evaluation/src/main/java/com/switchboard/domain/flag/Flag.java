package com.switchboard.domain.flag;

import java.util.List;
import java.util.UUID;

/**
 * @param clientSideAvailable whether a holder of a PUBLIC SDK key - one shipped inside a browser
 *     bundle or a mobile binary - may see this flag at all. Defaults to false, so no existing flag
 *     becomes newly exposed by the migration that introduced it.
 *     <p>This lives on the flag rather than on its per-environment config on purpose. Whether a
 *     flag's existence is a secret is a property of the flag, not of one environment's targeting -
 *     and the config row is the one every mutation snapshots, so putting it there would mean a
 *     targeting rollback could silently unpublish a flag from every browser as a side effect.
 *     <p>It has no effect on a SERVER key, which sees every flag exactly as it did before this
 *     field existed.
 */
public record Flag(
    UUID id,
    UUID projectId,
    String key,
    String name,
    String description,
    FlagKind kind,
    List<Variation> variations,
    List<String> tags,
    boolean archived,
    boolean clientSideAvailable) {

    public Flag {
        variations = variations == null ? List.of() : List.copyOf(variations);
        tags = tags == null ? List.of() : List.copyOf(tags);
    }

    /**
     * The pre-client-keys shape, defaulting to not client-side available. Keeps the evaluation
     * tests and the conformance vectors - which have no opinion about delivery - unchanged.
     */
    public Flag(
        UUID id, UUID projectId, String key, String name, String description, FlagKind kind,
        List<Variation> variations, List<String> tags, boolean archived) {
        this(id, projectId, key, name, description, kind, variations, tags, archived, false);
    }

    /** The variation with the given id, or null when the id is unknown. */
    public Variation variationById(UUID variationId) {
        if (variationId == null) {
            return null;
        }
        return variations.stream().filter(v -> v.id().equals(variationId)).findFirst().orElse(null);
    }
}
