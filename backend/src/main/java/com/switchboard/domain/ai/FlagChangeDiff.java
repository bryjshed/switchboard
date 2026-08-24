package com.switchboard.domain.ai;

import com.switchboard.domain.flag.FlagKind;
import java.util.List;

/**
 * The typed change an AI proposal will make. Mirrors the REST FlagChangeDiff
 * schema except that everything inside {@code envChanges} names variations by
 * VALUE - see the tool-schema convention on {@link FlagAssistantPort}.
 */
public record FlagChangeDiff(
    ProposalKind kind,
    String flagKey,
    String name,
    String description,
    FlagKind flagKind,
    List<VariationDraft> variations,
    List<String> tags,
    List<EnvChange> envChanges,
    Integer rollbackToVersion,
    List<String> retirementChecklist) {

    public FlagChangeDiff {
        variations = variations == null ? List.of() : List.copyOf(variations);
        tags = tags == null ? List.of() : List.copyOf(tags);
        envChanges = envChanges == null ? List.of() : List.copyOf(envChanges);
        retirementChecklist = retirementChecklist == null ? List.of() : List.copyOf(retirementChecklist);
    }
}
