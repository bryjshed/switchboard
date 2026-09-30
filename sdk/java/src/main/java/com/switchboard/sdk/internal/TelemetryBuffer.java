package com.switchboard.sdk.internal;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Buffers evaluation (exposure) events and metric events and sends them in batches: the Java
 * counterpart of the TypeScript SDK's {@code Telemetry}.
 *
 * <p>Both kinds matter. The rollout monitor attributes a metric to a variation only by joining
 * it to an evaluation event for the same context key, so metrics without exposures are
 * unattributable - which is why exposures are recorded on every local evaluation.
 *
 * <p><b>Bounded.</b> Each queue holds at most {@code maxQueueSize}; past it the OLDEST event is
 * dropped and counted, so an unreachable server never becomes an out-of-memory kill. Dropping
 * the oldest keeps the most recent behaviour, which is what anomaly detection needs.
 *
 * <p><b>Best effort.</b> A failed batch is logged and dropped rather than requeued: telemetry is
 * a signal, and an endlessly retried batch is only a slower memory leak.
 *
 * <p><b>Cheap on the hot path.</b> Recording an exposure happens inside every flag check, so it
 * is a lock-free queue append; the lock is only taken to wake the flusher.
 *
 * <p>One virtual thread flushes both queues every {@code flushInterval}. It also flushes early
 * once a full batch of METRICS is waiting (metrics are low-volume and each one matters).
 * Exposures deliberately do not trigger an early send, as in the TypeScript SDK: a hot loop
 * evaluating flags would otherwise turn into a request every {@code maxBatchSize} evaluations
 * and run straight into the server's per-key rate limit. The thread starts lazily with the first
 * event, so a client that never evaluates or tracks never starts it.
 */
public final class TelemetryBuffer {

    private static final Logger log = LoggerFactory.getLogger(TelemetryBuffer.class);

    /** One {@code EvalEventItem} of {@code POST /api/events/eval}. */
    public record EvalEvent(String flagKey, String contextKey, UUID variationId, String reason, Instant occurredAt) {
    }

    /** One {@code MetricEventItem} of {@code POST /api/events/metrics}. */
    public record MetricEvent(String contextKey, String metricKey, double value, Instant occurredAt) {
    }

    /** Sends one batch. Throwing means the batch failed and is dropped. */
    public interface Sender {
        void sendEvalEvents(List<EvalEvent> batch) throws Exception;

        void sendMetricEvents(List<MetricEvent> batch) throws Exception;
    }

    private final Sender sender;
    private final boolean enabled;
    private final Duration flushInterval;
    private final int maxBatchSize;
    private final int maxQueueSize;

    private final Bounded<EvalEvent> evalQueue = new Bounded<>();
    private final Bounded<MetricEvent> metricQueue = new Bounded<>();

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    /** Serialises flushes, so flush() returns only after everything queued before it is sent. */
    private final ReentrantLock flushLock = new ReentrantLock();

    private final AtomicBoolean started = new AtomicBoolean(false);
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicLong sent = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();
    private final AtomicLong failedFlushes = new AtomicLong();

    private volatile Thread worker;

    public TelemetryBuffer(Sender sender, boolean enabled, Duration flushInterval, int maxBatchSize,
        int maxQueueSize) {
        this.sender = sender;
        this.enabled = enabled;
        this.flushInterval = flushInterval;
        this.maxBatchSize = Math.max(1, maxBatchSize);
        this.maxQueueSize = Math.max(1, maxQueueSize);
    }

    public boolean enabled() {
        return enabled;
    }

    /** Records one evaluation. Lock-free; the HTTP call happens on the flush interval. */
    public void recordEvaluation(EvalEvent event) {
        if (!enabled || closed.get()) {
            return;
        }
        evalQueue.push(event);
        ensureStarted();
    }

    /** Records one metric. Wakes the flusher early once a full batch is waiting. */
    public void recordMetric(MetricEvent event) {
        if (!enabled || closed.get()) {
            return;
        }
        metricQueue.push(event);
        ensureStarted();
        if (metricQueue.size() >= maxBatchSize) {
            lock.lock();
            try {
                wake.signalAll();
            } finally {
                lock.unlock();
            }
        }
    }

    private void ensureStarted() {
        if (started.compareAndSet(false, true)) {
            worker = Thread.ofVirtual().name("switchboard-telemetry").start(this::runFlusher);
        }
    }

    /**
     * Sends everything queued, evaluations first, in batches of at most {@code maxBatchSize}.
     * Blocks until done. Never throws: a failed batch is logged, counted and dropped.
     */
    public void flush() {
        if (!enabled) {
            return;
        }
        flushLock.lock();
        try {
            List<EvalEvent> evals = evalQueue.drain();
            List<MetricEvent> metrics = metricQueue.drain();
            for (int from = 0; from < evals.size(); from += maxBatchSize) {
                List<EvalEvent> batch = List.copyOf(evals.subList(from, Math.min(evals.size(), from + maxBatchSize)));
                send(() -> sender.sendEvalEvents(batch), batch.size(), "eval");
            }
            for (int from = 0; from < metrics.size(); from += maxBatchSize) {
                List<MetricEvent> batch =
                    List.copyOf(metrics.subList(from, Math.min(metrics.size(), from + maxBatchSize)));
                send(() -> sender.sendMetricEvents(batch), batch.size(), "metric");
            }
        } finally {
            flushLock.unlock();
        }
    }

    @FunctionalInterface
    private interface Call {
        void run() throws Exception;
    }

    private void send(Call call, int count, String kind) {
        try {
            call.run();
            sent.addAndGet(count);
        } catch (Exception e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            failedFlushes.incrementAndGet();
            log.warn("Switchboard: failed to flush {} {} events: {}", count, kind, e.getMessage());
        }
    }

    /**
     * Stops the flusher, then sends what is left so a clean shutdown loses nothing. The whole
     * final flush is bounded by {@code timeout}; whatever is still unsent then is abandoned.
     * Idempotent.
     */
    public void close(Duration timeout) {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        Thread running = worker;
        lock.lock();
        try {
            wake.signalAll();
        } finally {
            lock.unlock();
        }
        if (running == null && evalQueue.size() == 0 && metricQueue.size() == 0) {
            return;
        }
        Thread last = Thread.ofVirtual().name("switchboard-telemetry-close").start(() -> {
            if (running != null) {
                try {
                    running.join();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            flush();
        });
        try {
            if (!last.join(timeout)) {
                last.interrupt();
                log.warn("Switchboard: telemetry not fully delivered within {} of close(); {} events left unsent",
                    timeout, evalQueue.size() + metricQueue.size());
            }
        } catch (InterruptedException e) {
            last.interrupt();
            Thread.currentThread().interrupt();
        }
    }

    public int queuedEvalEvents() {
        return evalQueue.size();
    }

    public int queuedMetricEvents() {
        return metricQueue.size();
    }

    public long sent() {
        return sent.get();
    }

    public long dropped() {
        return dropped.get();
    }

    public long failedFlushes() {
        return failedFlushes.get();
    }

    /** Waits for the interval (or a full metric batch), then flushes. Exits once closed. */
    private void runFlusher() {
        boolean timed = !flushInterval.isZero();
        while (true) {
            lock.lock();
            try {
                long remaining = timed ? flushInterval.toNanos() : 0L;
                while (!closed.get() && metricQueue.size() < maxBatchSize && (!timed || remaining > 0)) {
                    if (timed) {
                        remaining = wake.awaitNanos(remaining);
                    } else {
                        wake.await(1, TimeUnit.HOURS);
                    }
                }
                if (closed.get()) {
                    // close() owns the final flush, bounded by its timeout.
                    return;
                }
            } catch (InterruptedException e) {
                return;
            } finally {
                lock.unlock();
            }
            flush();
        }
    }

    /**
     * A lock-free queue with an approximate size, bounded by dropping from the head. The size can
     * briefly overshoot by the number of concurrent writers, never grow without bound.
     */
    private final class Bounded<T> {
        private final ConcurrentLinkedQueue<T> items = new ConcurrentLinkedQueue<>();
        private final AtomicInteger size = new AtomicInteger();

        void push(T item) {
            items.offer(item);
            if (size.incrementAndGet() > maxQueueSize && items.poll() != null) {
                size.decrementAndGet();
                dropped.incrementAndGet();
            }
        }

        int size() {
            return Math.max(0, size.get());
        }

        List<T> drain() {
            List<T> out = new ArrayList<>();
            T item;
            while ((item = items.poll()) != null) {
                size.decrementAndGet();
                out.add(item);
            }
            return out;
        }
    }
}
