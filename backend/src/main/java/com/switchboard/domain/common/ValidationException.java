package com.switchboard.domain.common;

public class ValidationException extends RuntimeException {
    public ValidationException(String message) {
        super(message);
    }
}
