package com.switchboard.interfaces.rest.ofrep;

/**
 * OpenFeature error codes as used by OFREP.
 *
 * <p>Only the subset Switchboard can actually produce is listed; OFREP allows any OpenFeature
 * error code on the wire, so adding one here is a pure addition for callers.
 */
public enum OfrepErrorCode {
    PARSE_ERROR,
    TARGETING_KEY_MISSING,
    INVALID_CONTEXT,
    FLAG_NOT_FOUND,
    GENERAL
}
