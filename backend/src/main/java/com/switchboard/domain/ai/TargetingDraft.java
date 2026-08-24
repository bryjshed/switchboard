package com.switchboard.domain.ai;

import java.util.List;

/**
 * A proposed targeting config in variation VALUES. Every field is optional: a
 * null field means "leave the current head config's field alone", which lets a
 * proposal describe a single edit (for example "serve 100% control") without
 * having to restate the whole config.
 */
public record TargetingDraft(
    List<ValueTarget> individualTargets,
    List<ValueRule> rules,
    ValueServe fallthrough,
    String offVariationValue,
    String defaultVariationValue) {
}
