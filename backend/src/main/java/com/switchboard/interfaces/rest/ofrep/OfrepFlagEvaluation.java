package com.switchboard.interfaces.rest.ofrep;

/**
 * One entry of the bulk {@code flags} array: OFREP models it as
 * {@code oneOf [evaluationSuccess, evaluationFailure]}, which is a closed union.
 */
public sealed interface OfrepFlagEvaluation
    permits OfrepEvaluationSuccess, OfrepEvaluationFailure {

    /** The flag key this entry is about; required by OFREP on both arms of the union. */
    String key();
}
