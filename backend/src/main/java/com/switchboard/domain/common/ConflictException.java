package com.switchboard.domain.common;

public class ConflictException extends RuntimeException {
    public ConflictException(String message) {
        super(message);
    }
}
