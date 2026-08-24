package com.switchboard.interfaces.rest.ofrep;

/**
 * A request OFREP defines as a 400. {@code flagKey} is the single-evaluation flag key and is null
 * on the bulk endpoint, whose {@code bulkEvaluationFailure} schema has no key.
 */
public class OfrepBadRequestException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final transient String flagKey;
    private final OfrepErrorCode errorCode;

    public OfrepBadRequestException(String flagKey, OfrepErrorCode errorCode, String message) {
        super(message);
        this.flagKey = flagKey;
        this.errorCode = errorCode;
    }

    public String flagKey() {
        return flagKey;
    }

    public OfrepErrorCode errorCode() {
        return errorCode;
    }
}
