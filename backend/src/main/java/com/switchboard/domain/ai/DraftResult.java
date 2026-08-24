package com.switchboard.domain.ai;

/** What the assistant produced: the typed diff plus its plain-language rationale. */
public record DraftResult(FlagChangeDiff diff, String rationale) {
}
