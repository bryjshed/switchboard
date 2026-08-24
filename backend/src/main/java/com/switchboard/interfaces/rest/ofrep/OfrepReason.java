package com.switchboard.interfaces.rest.ofrep;

/**
 * The OpenFeature resolution reasons OFREP allows on an {@code evaluationSuccess}.
 *
 * <p>Deliberately NOT Switchboard's {@link com.switchboard.domain.evaluation.EvalReason}: OFREP
 * clients switch on this closed set, so the native reason is carried alongside in
 * {@code metadata["switchboard.reason"]} rather than leaked into this enum.
 */
public enum OfrepReason {
    STATIC,
    TARGETING_MATCH,
    SPLIT,
    DISABLED,
    UNKNOWN
}
