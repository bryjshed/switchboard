package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.switchboard.sdk.internal.TelemetryBuffer;
import com.switchboard.sdk.internal.TelemetryBuffer.EvalEvent;
import com.switchboard.sdk.internal.TelemetryBuffer.MetricEvent;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** The telemetry buffer against a fake sender: bounds, batching, ordering, timing, shutdown. */
class TelemetryBufferTest {

    private final List<String> calls = new CopyOnWriteArrayList<>();
    private final List<List<EvalEvent>> evalBatches = new CopyOnWriteArrayList<>();
    private final List<List<MetricEvent>> metricBatches = new CopyOnWriteArrayList<>();

    private final TelemetryBuffer.Sender recording = new TelemetryBuffer.Sender() {
        @Override
        public void sendEvalEvents(List<EvalEvent> batch) {
            calls.add("eval");
            evalBatches.add(batch);
        }

        @Override
        public void sendMetricEvents(List<MetricEvent> batch) {
            calls.add("metric");
            metricBatches.add(batch);
        }
    };

    private static MetricEvent metric(String contextKey) {
        return new MetricEvent(contextKey, "conversion", 1d, Instant.now());
    }

    private static EvalEvent eval(String contextKey) {
        return new EvalEvent("flag", contextKey, null, "DEFAULT", Instant.now());
    }

    private TelemetryBuffer buffer(Duration interval, int batch, int queue) {
        return new TelemetryBuffer(recording, true, interval, batch, queue);
    }

    @Test
    void flushSendsEverythingInBatchesOfAtMostMaxBatchSize() {
        var buffer = buffer(Duration.ofHours(1), 2, 100);
        for (int i = 0; i < 5; i++) {
            buffer.recordMetric(metric("u" + i));
        }
        buffer.flush();
        // A full batch may already have gone early; either way nothing exceeds the cap and
        // every event is sent exactly once, in order.
        assertTrue(metricBatches.stream().allMatch(b -> b.size() <= 2));
        assertEquals(List.of("u0", "u1", "u2", "u3", "u4"),
            metricBatches.stream().flatMap(List::stream).map(MetricEvent::contextKey).toList());
        assertEquals(5, buffer.sent());
        assertEquals(0, buffer.queuedMetricEvents());
        buffer.close(Duration.ofSeconds(1));
    }

    @Test
    void evaluationsAreSentBeforeMetricsInOneFlush() {
        // An exposure has to land no later than the metric it explains.
        var buffer = buffer(Duration.ofHours(1), 500, 100);
        buffer.recordMetric(metric("u"));
        buffer.recordEvaluation(eval("u"));
        buffer.flush();
        assertEquals(List.of("eval", "metric"), calls);
        buffer.close(Duration.ofSeconds(1));
    }

    @Test
    void aFullQueueDropsTheOldestAndCountsIt() {
        var buffer = buffer(Duration.ofHours(1), 500, 3);
        for (int i = 0; i < 5; i++) {
            buffer.recordEvaluation(eval("u" + i));
        }
        assertEquals(3, buffer.queuedEvalEvents());
        assertEquals(2, buffer.dropped());
        buffer.flush();
        // The most recent behaviour is what anomaly detection needs, so the newest survive.
        assertEquals(List.of("u2", "u3", "u4"),
            evalBatches.get(0).stream().map(EvalEvent::contextKey).toList());
        buffer.close(Duration.ofSeconds(1));
    }

    @Test
    void theQueuesAreBoundedSeparately() {
        var buffer = buffer(Duration.ofHours(1), 500, 2);
        buffer.recordEvaluation(eval("a"));
        buffer.recordEvaluation(eval("b"));
        buffer.recordMetric(metric("a"));
        buffer.recordMetric(metric("b"));
        assertEquals(0, buffer.dropped(), "a busy flag loop must not evict metrics");
        buffer.close(Duration.ofSeconds(1));
    }

    @Test
    void theIntervalFlushesWithoutBeingAsked() throws Exception {
        var sentOne = new CountDownLatch(1);
        var buffer = new TelemetryBuffer(new TelemetryBuffer.Sender() {
            @Override
            public void sendEvalEvents(List<EvalEvent> batch) {
                sentOne.countDown();
            }

            @Override
            public void sendMetricEvents(List<MetricEvent> batch) {
            }
        }, true, Duration.ofMillis(50), 500, 100);
        buffer.recordEvaluation(eval("u"));
        assertTrue(sentOne.await(5, TimeUnit.SECONDS), "the timer should have flushed");
        buffer.close(Duration.ofSeconds(1));
    }

    @Test
    void aFullMetricBatchGoesEarlyWithoutWaitingForTheInterval() throws Exception {
        var buffer = buffer(Duration.ofHours(1), 3, 100);
        buffer.recordMetric(metric("a"));
        buffer.recordMetric(metric("b"));
        buffer.recordMetric(metric("c"));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (metricBatches.isEmpty() && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertEquals(1, metricBatches.size(), "a full batch of metrics should not wait an hour");
        buffer.close(Duration.ofSeconds(1));
    }

    @Test
    void evaluationsNeverTriggerAnEarlySend() throws Exception {
        // A hot loop of flag checks would otherwise become a request per maxBatchSize
        // evaluations and hit the per-key rate limit. Same rule as the TypeScript SDK.
        var buffer = buffer(Duration.ofHours(1), 3, 100);
        for (int i = 0; i < 10; i++) {
            buffer.recordEvaluation(eval("u" + i));
        }
        Thread.sleep(150);
        assertTrue(evalBatches.isEmpty());
        buffer.close(Duration.ofSeconds(1));
        assertEquals(10, buffer.sent());
    }

    @Test
    void aZeroIntervalDisablesTheTimerButNotFlush() throws Exception {
        var buffer = buffer(Duration.ZERO, 500, 100);
        buffer.recordMetric(metric("u"));
        Thread.sleep(100);
        assertTrue(metricBatches.isEmpty());
        buffer.flush();
        assertEquals(1, metricBatches.size());
        buffer.close(Duration.ofSeconds(1));
    }

    @Test
    void aFailedBatchIsCountedAndNotRetried() {
        var attempts = new AtomicInteger();
        var buffer = new TelemetryBuffer(new TelemetryBuffer.Sender() {
            @Override
            public void sendEvalEvents(List<EvalEvent> batch) {
            }

            @Override
            public void sendMetricEvents(List<MetricEvent> batch) throws IOException {
                attempts.incrementAndGet();
                throw new IOException("HTTP 500");
            }
        }, true, Duration.ofHours(1), 500, 100);
        buffer.recordMetric(metric("a"));
        buffer.recordMetric(metric("b"));
        buffer.flush();
        buffer.flush();
        assertEquals(1, attempts.get(), "a failed batch must not be requeued");
        assertEquals(0, buffer.sent());
        assertEquals(1, buffer.failedFlushes());
        // dropped counts queue overflow only, as in the TypeScript SDK.
        assertEquals(0, buffer.dropped());
        buffer.close(Duration.ofSeconds(1));
    }

    @Test
    void disabledRecordsAndSendsNothing() {
        var buffer = new TelemetryBuffer(recording, false, Duration.ofMillis(10), 1, 100);
        buffer.recordEvaluation(eval("u"));
        buffer.recordMetric(metric("u"));
        buffer.flush();
        buffer.close(Duration.ofSeconds(1));
        assertEquals(0, buffer.queuedEvalEvents() + buffer.queuedMetricEvents());
        assertTrue(calls.isEmpty());
    }

    @Test
    void closeSendsWhatIsLeftAndThenIgnoresNewEvents() {
        var buffer = buffer(Duration.ofHours(1), 500, 100);
        buffer.recordEvaluation(eval("a"));
        buffer.recordMetric(metric("a"));
        buffer.close(Duration.ofSeconds(2));
        assertEquals(2, buffer.sent(), "a clean shutdown loses nothing");
        buffer.recordMetric(metric("after-close"));
        buffer.recordEvaluation(eval("after-close"));
        assertEquals(0, buffer.queuedEvalEvents() + buffer.queuedMetricEvents());
        buffer.close(Duration.ofSeconds(2));
        assertEquals(2, calls.size());
    }

    @Test
    void closeIsBoundedByItsTimeoutWhenTheServerHangs() {
        var buffer = new TelemetryBuffer(new TelemetryBuffer.Sender() {
            @Override
            public void sendEvalEvents(List<EvalEvent> batch) throws InterruptedException {
                Thread.sleep(10_000);
            }

            @Override
            public void sendMetricEvents(List<MetricEvent> batch) {
            }
        }, true, Duration.ofHours(1), 500, 100);
        buffer.recordEvaluation(eval("a"));
        long started = System.nanoTime();
        buffer.close(Duration.ofMillis(200));
        long tookMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        assertTrue(tookMillis < 5_000, "close() took " + tookMillis + "ms");
    }

    @Test
    void closeOnABufferThatNeverRecordedIsImmediate() {
        var buffer = buffer(Duration.ofHours(1), 500, 100);
        buffer.close(Duration.ofSeconds(1));
        assertTrue(calls.isEmpty());
    }
}
