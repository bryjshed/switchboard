import type { Backoff } from './backoff.js';
import type { FetchLike } from './config.js';
import type { Logger } from './logger.js';
import { SwitchboardHttpError } from './http.js';

/** One dispatched Server-Sent Event. */
export interface SseMessage {
  /** The `event:` field, or `message` when the server omitted it, per the SSE specification. */
  type: string;
  /** The `data:` field, with multiple data lines joined by a newline. */
  data: string;
  /** The `id:` field when present on this event. */
  lastEventId: string | null;
}

const CR = '\r';
const LF = '\n';

/**
 * Incremental `text/event-stream` parser.
 *
 * Hand-rolled rather than pulling in an SSE dependency: the wire format is a handful of lines, the
 * SDK already needs `fetch` for bootstrap, and every off-the-shelf client either drags in a
 * polyfill tree or hides the `Last-Event-ID` handling this SDK has to control. `EventSource` in
 * particular cannot send an `Authorization` header, which rules it out for an SDK-key API.
 *
 * Handles CRLF and LF line endings, multi-line `data:`, comment lines (`: keepalive`) and the
 * single optional space after a field's colon.
 */
export class SseParser {
  private buffer = '';
  private eventType = '';
  private dataLines: string[] = [];
  private eventId: string | null = null;

  /** Feeds a chunk of decoded text and returns every complete event it produced. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    let newlineIndex: number;
    // Split on LF and tolerate a trailing CR; a lone CR line terminator is not produced by any
    // server this SDK talks to and is deliberately not supported.
    while ((newlineIndex = this.buffer.indexOf(LF)) !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith(CR)) {
        line = line.slice(0, -1);
      }
      const message = this.handleLine(line);
      if (message !== null) {
        messages.push(message);
      }
    }
    return messages;
  }

  private handleLine(line: string): SseMessage | null {
    if (line === '') {
      return this.dispatch();
    }
    if (line.startsWith(':')) {
      // A comment. Servers use these as keepalives; nothing to dispatch.
      return null;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        this.eventId = value;
        break;
      default:
        // `retry` and anything unknown: the SDK owns its own backoff policy, so ignore it.
        break;
    }
    return null;
  }

  private dispatch(): SseMessage | null {
    if (this.dataLines.length === 0 && this.eventType === '') {
      this.reset();
      return null;
    }
    const message: SseMessage = {
      type: this.eventType === '' ? 'message' : this.eventType,
      data: this.dataLines.join(LF),
      lastEventId: this.eventId,
    };
    this.reset();
    return message;
  }

  private reset(): void {
    this.eventType = '';
    this.dataLines = [];
    this.eventId = null;
  }
}

export interface SseClientOptions {
  url: string;
  headers: Record<string, string>;
  fetch: FetchLike;
  backoff: Backoff;
  logger: Logger;
  /** Resume point sent as `Last-Event-ID` on reconnect. */
  lastEventId?: string | null;
  onMessage: (message: SseMessage) => void;
  onOpen: () => void;
  /** Called on every disconnect. `retryInMs` is null when the client has given up. */
  onError: (error: unknown, retryInMs: number | null) => void;
}

/**
 * A reconnecting SSE reader over `fetch`.
 *
 * Never rejects and never throws into the caller: a dropped stream is a logged event and a
 * scheduled reconnect, while the config store keeps serving whatever it last knew. The only
 * terminal condition is 401/403, where the key itself is wrong and retrying cannot help.
 */
export class SseClient {
  private stopped = false;
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolver for an in-progress backoff sleep, so `stop()` can wake it instead of orphaning it. */
  private wakeSleep: (() => void) | null = null;
  /** The reader of the body currently being consumed, so `stop()` can end the read directly. */
  private reader: StreamReader | null = null;
  private lastEventId: string | null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: SseClientOptions) {
    this.lastEventId = options.lastEventId ?? null;
  }

  get currentLastEventId(): string | null {
    return this.lastEventId;
  }

  /** Starts the connect/read/reconnect loop. Returns immediately. */
  start(): void {
    if (this.running !== null) {
      return;
    }
    this.stopped = false;
    this.running = this.loop();
  }

  /**
   * Aborts the in-flight request and cancels any pending reconnect. Idempotent, never rejects.
   *
   * Every way the loop can be parked has to be woken explicitly, because `await`ing the loop while
   * something inside it can never settle is a deadlock in `close()`:
   *  - parked in a backoff sleep: clearing the timer alone leaves its promise forever pending, so
   *    the resolver is called by hand;
   *  - parked reading the response body: not every `fetch` implementation honours an abort signal
   *    (a mock or a shim may ignore it), so the reader is cancelled directly as well.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const wake = this.wakeSleep;
    this.wakeSleep = null;
    wake?.();
    this.controller?.abort();
    await this.cancelReader();
    const running = this.running;
    this.running = null;
    if (running !== null) {
      await running;
    }
  }

  private async cancelReader(): Promise<void> {
    const reader = this.reader;
    this.reader = null;
    if (reader === null) {
      return;
    }
    try {
      await reader.cancel();
    } catch {
      // Cancelling an already-broken stream is not an error worth surfacing.
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectAndRead();
        if (this.stopped) {
          return;
        }
        throw new Error('stream closed by server');
      } catch (error) {
        if (this.stopped) {
          return;
        }
        if (error instanceof SwitchboardHttpError && error.isUnauthorized) {
          this.options.logger.error('stream authentication failed; not reconnecting', error);
          this.options.onError(error, null);
          return;
        }
        const delay = this.options.backoff.next();
        this.options.logger.warn(`stream disconnected, reconnecting in ${delay}ms`, error);
        this.options.onError(error, delay);
        await this.sleep(delay);
      }
    }
  }

  private async connectAndRead(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const headers: Record<string, string> = {
      ...this.options.headers,
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    };
    if (this.lastEventId !== null) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    const response = await this.options.fetch(this.options.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SwitchboardHttpError(`stream failed with HTTP ${response.status}`, response.status);
    }
    if (response.body === null || response.body === undefined) {
      throw new Error('stream response had no body');
    }

    const reader = toReader(response.body);
    this.reader = reader;
    if (this.stopped) {
      // stop() landed between the fetch and the read; nothing is watching this stream any more.
      await this.cancelReader();
      return;
    }

    this.options.backoff.reset();
    this.options.onOpen();

    const parser = new SseParser();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.stopped) {
          return;
        }
        if (value === undefined) {
          continue;
        }
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          if (message.lastEventId !== null) {
            this.lastEventId = message.lastEventId;
          }
          this.options.onMessage(message);
        }
      }
    } finally {
      if (this.reader === reader) {
        this.reader = null;
      }
      reader.release();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.retryTimer !== null) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.wakeSleep = null;
        resolve();
      };
      this.wakeSleep = finish;
      this.retryTimer = setTimeout(finish, ms);
      // A pending reconnect must never hold a Node process open.
      unref(this.retryTimer);
    });
  }
}

/** The uniform read/cancel handle {@link SseClient} drives, whatever shape the body arrived in. */
interface StreamReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
  release: () => void;
}

/**
 * Wraps a response body in a reader the client can both pull from and cancel.
 *
 * `getReader()` is preferred over async iteration because cancellation has to be explicit: a
 * `for await` over a stream can only be ended from inside the loop, and the loop is parked on a
 * read that may never produce another chunk. A Node-style async-iterable body is supported too, for
 * fetch shims that do not expose a WHATWG stream.
 */
function toReader(body: unknown): StreamReader {
  const stream = body as {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
      cancel: (reason?: unknown) => Promise<void>;
      releaseLock: () => void;
    };
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  };
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    let released = false;
    return {
      read: () => reader.read(),
      cancel: async () => {
        await reader.cancel();
      },
      release: () => {
        if (!released) {
          released = true;
          try {
            reader.releaseLock();
          } catch {
            // Releasing a lock held by a pending read is not fatal; the stream is being dropped.
          }
        }
      },
    };
  }
  const iterate = stream[Symbol.asyncIterator];
  if (typeof iterate === 'function') {
    const iterator = iterate.call(stream) as AsyncIterator<Uint8Array>;
    return {
      read: async () => {
        const next = await iterator.next();
        return { done: next.done === true, value: next.value };
      },
      cancel: async () => {
        await iterator.return?.(undefined);
      },
      release: () => {},
    };
  }
  throw new Error('stream body is neither a ReadableStream nor async-iterable');
}

/** Detaches a timer from the Node event loop where the runtime supports it. */
export function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}
