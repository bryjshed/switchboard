package com.switchboard.interfaces.rest.ofrep;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/**
 * OFREP {@code evaluationFailure} / {@code flagNotFound}, and - with a null {@code key} - the
 * {@code bulkEvaluationFailure} of the bulk endpoint, whose schema carries no key.
 *
 * <p>Nulls are omitted, so one record serializes to whichever of those three shapes is required.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record OfrepEvaluationFailure(
    String key,
    OfrepErrorCode errorCode,
    String errorDetails,
    Map<String, Object> metadata) implements OfrepFlagEvaluation {

    public static OfrepEvaluationFailure of(String key, OfrepErrorCode errorCode, String errorDetails) {
        return new OfrepEvaluationFailure(key, errorCode, errorDetails, null);
    }
}
