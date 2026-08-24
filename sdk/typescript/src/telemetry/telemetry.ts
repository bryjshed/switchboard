import type { EvalEventItem, EvalReason, MetricEventItem } from '../types.js';
import type { ResolvedConfig } from '../client/config.js';
import { sendEvalEvents, sendMetricEvents, SwitchboardHttpError } from '../client/http.js';
import { unref } from '../client/sse.js';

export interface TelemetryStats {
  /** Evaluation events waiting to be sent. */
  queuedEvalEvents: number;
  /** Metric events waiting to be sent. */
  queuedMetricEvents: number;
  /** Events discarded because a queue was full, since the client started. */
  dropped: number;
  /** Events accepted by the server (HTTP 202), since the client started. */
  sent: number;
  /** Flush attempts that failed. */
  failedFlushes: number;
}

/**
 * Buffers evaluation and metric events and flushes them in batches.
 *
 * Switchboard's healing and optimizing loops are fed entirely by these events, so the buffer is on
 * by default. It is also strictly bounded: past `maxQueueSize` the OLDEST events are dropped, which
 * keeps a client that cannot reach the backend from turning a network outage into an out-of-memory
 * kill. Dropping the oldest rather than the newest keeps the most recent behaviour visible, which
 * is what anomaly detection actually needs.
 *
 * A failed flush drops that batch rather than requeueing it. Telemetry is a best-effort signal, and
 * an infinitely retried batch is just a slower memory leak.
 */
export class Telemetry {
  private evalQueue: EvalEventItem[] = [];
  private metricQueue: MetricEventItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  private sent = 0;
  private failedFlushes = 0;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly config: ResolvedConfig) {}

  get enabled(): boolean {
    return this.config.telemetry.enabled;
  }

  get stats(): TelemetryStats {
    return {
      queuedEvalEvents: this.evalQueue.length,
      queuedMetricEvents: this.metricQueue.length,
      dropped: this.dropped,
      sent: this.sent,
      failedFlushes: this.failedFlushes,
    };
  }

  /** Starts the periodic flush. No-op when telemetry is disabled. */
  start(): void {
    if (!this.enabled || this.timer !== null || this.config.telemetry.flushIntervalMs === 0) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.telemetry.flushIntervalMs);
    unref(this.timer);
  }

  /** Records one evaluation. Cheap and synchronous; the HTTP call happens on the flush interval. */
  recordEvaluation(
    flagKey: string,
    contextKey: string,
    variationId: string | null,
    reason: EvalReason,
    occurredAt = new Date(),
  ): void {
    if (!this.enabled || this.closed) {
      return;
    }
    this.push(this.evalQueue, {
      flagKey,
      contextKey,
      variationId,
      reason,
      occurredAt: occurredAt.toISOString(),
    });
  }

  /** Records one metric: a conversion, an error, or anything else worth optimizing against. */
  recordMetric(
    metricKey: string,
    contextKey: string,
    value = 1,
    occurredAt = new Date(),
  ): void {
    if (!this.enabled || this.closed) {
      return;
    }
    this.push(this.metricQueue, {
      contextKey,
      metricKey,
      value,
      occurredAt: occurredAt.toISOString(),
    });
  }

  private push<T>(queue: T[], event: T): void {
    const max = this.config.telemetry.maxQueueSize;
    if (queue.length >= max) {
      // Drop-oldest: the queue can never grow past its cap, whatever the backend is doing.
      const overflow = queue.length - max + 1;
      queue.splice(0, overflow);
      this.dropped += overflow;
    }
    queue.push(event);
  }

  /**
   * Sends everything buffered. Never rejects: a failed flush is logged and counted.
   *
   * Concurrent calls are serialised so an interval tick and an explicit `flush()` cannot send the
   * same events twice.
   */
  flush(): Promise<void> {
    const run = this.inFlight.then(() => this.doFlush());
    this.inFlight = run.catch(() => undefined);
    return this.inFlight;
  }

  private async doFlush(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const evalBatches = drain(this.evalQueue, this.config.telemetry.maxBatchSize);
    const metricBatches = drain(this.metricQueue, this.config.telemetry.maxBatchSize);
    for (const batch of evalBatches) {
      await this.send(() => sendEvalEvents(this.config, batch), batch.length, 'eval');
    }
    for (const batch of metricBatches) {
      await this.send(() => sendMetricEvents(this.config, batch), batch.length, 'metric');
    }
  }

  private async send(call: () => Promise<void>, count: number, kind: string): Promise<void> {
    try {
      await call();
      this.sent += count;
    } catch (error) {
      this.failedFlushes += 1;
      const level =
        error instanceof SwitchboardHttpError && error.isUnauthorized ? 'error' : 'warn';
      this.config.logger[level](`failed to flush ${count} ${kind} events`, error);
    }
  }

  /** Stops the interval and flushes what is left, so a clean shutdown loses no events. */
  async close(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.closed = true;
  }
}

/** Removes everything from `queue` and returns it split into chunks of at most `size`. */
function drain<T>(queue: T[], size: number): T[][] {
  if (queue.length === 0) {
    return [];
  }
  const all = queue.splice(0, queue.length);
  const batches: T[][] = [];
  for (let index = 0; index < all.length; index += size) {
    batches.push(all.slice(index, index + size));
  }
  return batches;
}
