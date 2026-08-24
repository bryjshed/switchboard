/** Listener signature for {@link Emitter}. */
export type Listener<T> = (payload: T) => void;

/**
 * A tiny synchronous event emitter.
 *
 * Hand-rolled rather than `node:events` so the same code can run unmodified on runtimes that do
 * not ship Node's EventEmitter, and so a throwing listener can never escape into the SDK's own
 * control flow.
 */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  /** Emits to every listener. A listener that throws is isolated and reported to `onError`. */
  emit<K extends keyof Events>(
    event: K,
    payload: Events[K],
    onError?: (error: unknown) => void,
  ): void {
    const set = this.listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        onError?.(error);
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
