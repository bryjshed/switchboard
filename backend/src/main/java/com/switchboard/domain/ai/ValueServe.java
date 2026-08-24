package com.switchboard.domain.ai;

import java.util.List;

/**
 * A serve expressed in variation VALUES rather than ids: exactly one of
 * {@code variationValue} or {@code rollout} is set. Values are used because a
 * FLAG_CREATE proposal describes a flag whose variations do not exist yet - see
 * the tool-schema convention on {@link FlagAssistantPort}.
 */
public record ValueServe(String variationValue, List<ValueWeight> rollout) {

    public ValueServe {
        rollout = rollout == null ? List.of() : List.copyOf(rollout);
    }

    public static ValueServe ofValue(String variationValue) {
        return new ValueServe(variationValue, null);
    }

    public static ValueServe ofRollout(List<ValueWeight> rollout) {
        return new ValueServe(null, rollout);
    }

    public boolean hasRollout() {
        return !rollout.isEmpty();
    }
}
