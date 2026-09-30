package com.switchboard.sdk;

/**
 * Telemetry counters since the client was created: the same five fields as the TypeScript
 * SDK's {@code TelemetryStats}.
 *
 * <p>Worth surfacing on a health or metrics endpoint. Evaluation and metric events are the only
 * input to Switchboard's heal and optimize loops, so a rising {@code dropped} or
 * {@code failedFlushes} means those loops are deciding on less evidence than the application
 * produces.
 *
 * @param queuedEvalEvents   evaluation (exposure) events waiting to be sent
 * @param queuedMetricEvents metric events waiting to be sent
 * @param dropped            events discarded because a queue was full (oldest first)
 * @param sent               events the server accepted (HTTP 202)
 * @param failedFlushes      batch requests that failed; their events are not retried
 */
public record TelemetryStats(
    int queuedEvalEvents, int queuedMetricEvents, long dropped, long sent, long failedFlushes) {
}
