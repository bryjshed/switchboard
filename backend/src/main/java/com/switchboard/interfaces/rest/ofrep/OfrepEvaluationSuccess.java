package com.switchboard.interfaces.rest.ofrep;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/**
 * OFREP {@code evaluationSuccess} / {@code serverEvaluationSuccess}.
 *
 * <p>{@code value} is {@link Object} because OFREP types it as a union of boolean, string, integer,
 * float and object. Switchboard emits a real JSON boolean for BOOLEAN flags and the raw string for
 * STRING flags; it never guesses a richer type out of a string.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record OfrepEvaluationSuccess(
    String key,
    Object value,
    OfrepReason reason,
    String variant,
    Map<String, Object> metadata) implements OfrepFlagEvaluation {
}
