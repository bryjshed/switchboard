package com.switchboard.domain.ai;

import com.switchboard.domain.flag.FlagKind;
import java.util.List;

/** One existing flag as the assistant sees it: key, kind, variation VALUES, tags. */
public record FlagSnapshotItem(String key, FlagKind kind, List<String> variationValues, List<String> tags) {

    public FlagSnapshotItem {
        variationValues = variationValues == null ? List.of() : List.copyOf(variationValues);
        tags = tags == null ? List.of() : List.copyOf(tags);
    }
}
