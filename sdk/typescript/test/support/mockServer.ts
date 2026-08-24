/**
 * A programmable stand-in for the Switchboard API.
 *
 * Records every request so a test can assert on headers (`If-None-Match`, `Last-Event-ID`), and
 * exposes a controllable SSE stream so a test can push `put` / `patch` / `ping` frames and drop the
 * connection on demand.
 */
import type { BootstrapResponse, Flag, PatchEvent, Segment } from '../../src/types.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export class StreamHandle {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private closed = false;
  readonly body: ReadableStream<Uint8Array>;

  constructor() {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
        this.controller = null;
      },
    });
  }

  /** Writes a raw SSE frame. */
  raw(text: string): void {
    if (this.controller === null || this.closed) {
      return;
    }
    this.controller.enqueue(new TextEncoder().encode(text));
  }

  send(event: string, data: unknown, id?: number | string): void {
    const idLine = id === undefined ? '' : `id:${id}\n`;
    this.raw(`${idLine}event:${event}\ndata:${JSON.stringify(data)}\n\n`);
  }

  ping(): void {
    this.raw('event:ping\ndata:\n\n');
  }

  /** Ends the stream as if the server hung up. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.controller?.close();
    } catch {
      // Already closed by a cancel from the reader side.
    }
    this.controller = null;
  }

  /** Errors the stream as a real `fetch` does when the caller's AbortSignal fires. */
  abort(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.controller?.error(abortError());
    } catch {
      // Already torn down.
    }
    this.controller = null;
  }
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

export interface MockServerOptions {
  bootstrap?: BootstrapResponse;
  /** Forced status for `GET /api/eval/bootstrap`. */
  bootstrapStatus?: number;
  /** Forced status for `GET /api/stream`. */
  streamStatus?: number;
  /** Reject the bootstrap request outright, as a DNS or connection failure would. */
  bootstrapNetworkError?: boolean;
  /** Forced status for `POST /api/events/*`. */
  eventsStatus?: number;
}

export class MockServer {
  readonly requests: RecordedRequest[] = [];
  readonly streams: StreamHandle[] = [];
  bootstrap: BootstrapResponse;
  bootstrapStatus: number;
  streamStatus: number;
  bootstrapNetworkError: boolean;
  eventsStatus: number;
  /** Resolves on each new `GET /api/stream` connection. */
  private streamWaiters: Array<(handle: StreamHandle) => void> = [];

  constructor(options: MockServerOptions = {}) {
    this.bootstrap = options.bootstrap ?? emptyBootstrap();
    this.bootstrapStatus = options.bootstrapStatus ?? 200;
    this.streamStatus = options.streamStatus ?? 200;
    this.bootstrapNetworkError = options.bootstrapNetworkError ?? false;
    this.eventsStatus = options.eventsStatus ?? 202;
  }

  get etag(): string {
    return `"${this.bootstrap.stateVersion}"`;
  }

  requestsTo(pathFragment: string): RecordedRequest[] {
    return this.requests.filter((request) => request.url.includes(pathFragment));
  }

  /** Waits for the next stream connection (or returns one already open). */
  nextStream(timeoutMs = 2_000): Promise<StreamHandle> {
    const pending = this.streams[this.streams.length - 1];
    if (pending !== undefined && this.streamWaiters.length === 0) {
      return Promise.resolve(pending);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no stream connection')), timeoutMs);
      this.streamWaiters.push((handle) => {
        clearTimeout(timer);
        resolve(handle);
      });
    });
  }

  /** Waits until `count` stream connections have been made. */
  async waitForStreamCount(count: number, timeoutMs = 3_000): Promise<StreamHandle> {
    const deadline = Date.now() + timeoutMs;
    while (this.streams.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} stream connections, saw ${this.streams.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.streams[count - 1] as StreamHandle;
  }

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = normaliseHeaders(init.headers);
    this.requests.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    });

    if (url.includes('/api/eval/bootstrap')) {
      if (this.bootstrapNetworkError) {
        throw new TypeError('fetch failed');
      }
      if (this.bootstrapStatus !== 200) {
        return new Response('nope', { status: this.bootstrapStatus });
      }
      if (headers['if-none-match'] === this.etag) {
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify(this.bootstrap), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: this.etag },
      });
    }

    if (url.includes('/api/stream')) {
      if (this.streamStatus !== 200) {
        return new Response('nope', { status: this.streamStatus });
      }
      const handle = new StreamHandle();
      // A real fetch tears the body down when the caller's signal fires. The SDK must not depend on
      // that being honoured, but the mock models it so the abort path is exercised too.
      const signal = init.signal;
      if (signal != null) {
        if (signal.aborted) {
          throw abortError();
        }
        signal.addEventListener('abort', () => handle.abort(), { once: true });
      }
      this.streams.push(handle);
      const waiters = this.streamWaiters;
      this.streamWaiters = [];
      for (const waiter of waiters) {
        waiter(handle);
      }
      return new Response(handle.body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    if (url.includes('/api/events/')) {
      return new Response(this.eventsStatus === 202 ? null : 'nope', { status: this.eventsStatus });
    }

    if (url.includes('/api/eval')) {
      return new Response(JSON.stringify({ flagKey: 'x', value: '', reason: 'SDK_DEFAULT' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  };
}

function normaliseHeaders(headers: RequestInit['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers === undefined) {
    return result;
  }
  for (const [name, value] of Object.entries(headers as Record<string, string>)) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

// -------------------------------------------------------------------------------------------
// Fixtures, shaped exactly like the live backend's bootstrap payload.
// -------------------------------------------------------------------------------------------

export const TRUE_VARIATION = '0a0a0a0a-0000-4000-8000-000000000001';
export const FALSE_VARIATION = '0a0a0a0a-0000-4000-8000-000000000002';

export function booleanFlag(key: string, overrides: Partial<Flag> = {}): Flag {
  return {
    key,
    kind: 'BOOLEAN',
    variations: [
      { id: TRUE_VARIATION, value: 'true', name: 'True' },
      { id: FALSE_VARIATION, value: 'false', name: 'False' },
    ],
    enabled: true,
    killSwitchActive: false,
    config: {
      individualTargets: [],
      rules: [],
      // The server always serialises both fields; the unused one is null / [].
      fallthrough: { variationId: TRUE_VARIATION, rollout: [] },
      offVariationId: FALSE_VARIATION,
      defaultVariationId: TRUE_VARIATION,
    },
    version: 1,
    ...overrides,
  };
}

export function emptyBootstrap(): BootstrapResponse {
  return { envKey: 'test', stateVersion: 1, flags: [], segments: [] };
}

export function bootstrapWith(flags: Flag[], segments: Segment[] = [], stateVersion = 1): BootstrapResponse {
  return { envKey: 'test', stateVersion, flags, segments };
}

export function patchFor(flag: Flag, stateVersion: number, overrides: Partial<PatchEvent> = {}): PatchEvent {
  return {
    flagKey: flag.key,
    enabled: flag.enabled,
    killSwitchActive: flag.killSwitchActive,
    config: flag.config,
    version: (flag.version ?? 1) + 1,
    stateVersion,
    ...overrides,
  };
}
