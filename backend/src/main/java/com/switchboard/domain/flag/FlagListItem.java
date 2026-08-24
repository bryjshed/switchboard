package com.switchboard.domain.flag;

import java.util.List;
import java.util.UUID;

/** Flag list read model: core fields plus one summary per environment. */
public record FlagListItem(
    UUID id,
    String key,
    String name,
    FlagKind kind,
    List<String> tags,
    List<FlagEnvSummaryView> environments) {

    public FlagListItem {
        tags = tags == null ? List.of() : List.copyOf(tags);
        environments = environments == null ? List.of() : List.copyOf(environments);
    }
}
