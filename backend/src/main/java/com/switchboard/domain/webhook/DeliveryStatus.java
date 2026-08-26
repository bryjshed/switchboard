package com.switchboard.domain.webhook;

/** Where one delivery attempt chain has got to. */
public enum DeliveryStatus {
    /** Queued or mid-retry. The only status the retry sweep looks at. */
    PENDING,
    /** The receiver answered 2xx. */
    DELIVERED,
    /** Attempts are exhausted, or the receiver answered in a way retrying cannot fix. */
    FAILED
}
