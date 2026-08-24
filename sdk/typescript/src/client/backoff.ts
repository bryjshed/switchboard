/** Reconnect delay policy: exponential growth with full jitter, clamped to a ceiling. */
export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** Returns a number in [0, 1). Injectable so tests can be deterministic. */
  random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  random: Math.random,
};

/**
 * Full-jitter backoff: `delay = random(0, min(maxMs, initialMs * factor^attempt))`.
 *
 * Full jitter rather than plain exponential so a backend restart does not bring every SDK instance
 * back in the same millisecond (a thundering herd is how a recovering service gets knocked over
 * again).
 */
export class Backoff {
  private attempt = 0;

  constructor(private readonly options: BackoffOptions = DEFAULT_BACKOFF) {}

  /** The delay for the next attempt, in milliseconds, and advances the attempt counter. */
  next(): number {
    const ceiling = Math.min(
      this.options.maxMs,
      this.options.initialMs * Math.pow(this.options.factor, this.attempt),
    );
    this.attempt += 1;
    return Math.floor(this.options.random() * ceiling);
  }

  /** Called after a successful connection so the next failure starts from the bottom again. */
  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}
