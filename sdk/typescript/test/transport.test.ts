/**
 * Transport behaviour against a mocked server.
 *
 * The theme of every test here is the same: the SDK is on the critical path of everything that
 * reads a flag, so a backend that is missing, slow, unauthorised or lying must degrade into
 * "serve the caller's default" and never into an exception.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Backoff, DEFAULT_BACKOFF } from '../src/client/backoff.js';
import { SwitchboardClient } from '../src/client/client.js';
import type { FetchLike } from '../src/client/config.js';
import { silentLogger } from '../src/client/logger.js';
import {
  bootstrapWith,
  booleanFlag,
  FALSE_VARIATION,
  MockServer,
  patchFor,
  TRUE_VARIATION,
} from './support/mockServer.js';

const CONTEXT = { key: 'user-1' };
const clients: SwitchboardClient[] = [];

function makeClient(
  server: MockServer,
  overrides: Partial<ConstructorParameters<typeof SwitchboardClient>[0]> = {},
): SwitchboardClient {
  const client = new SwitchboardClient({
    sdkKey: 'sb_srv_test_key',
    baseUrl: 'http://switchboard.test',
    fetch: server.fetch as FetchLike,
    logger: silentLogger,
    telemetry: false,
    ...overrides,
  });
  clients.push(client);
  return client;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('bootstrap', () => {
  it('loads flags and evaluates them locally', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { mode: 'polling' });
    await client.start();

    expect(client.status).toBe('READY');
    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(true);
    expect(client.stringDetail('dark-mode', CONTEXT, '').reason).toBe('DEFAULT');
  });

  it('sends the SDK key as a bearer token', async () => {
    const server = new MockServer();
    await makeClient(server, { mode: 'polling' }).start();
    expect(server.requestsTo('/api/eval/bootstrap')[0]?.headers['authorization']).toBe(
      'Bearer sb_srv_test_key',
    );
  });

  it('still resolves the caller default when the initial bootstrap fails', async () => {
    const server = new MockServer({ bootstrapNetworkError: true, streamStatus: 500 });
    const client = makeClient(server);

    // start() must not reject, however badly the backend is behaving.
    await expect(client.start()).resolves.toBeUndefined();

    expect(client.status).toBe('ERROR');
    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(false);
    expect(client.booleanValue('dark-mode', CONTEXT, true)).toBe(true);
    expect(client.stringValue('anything', CONTEXT, 'fallback')).toBe('fallback');

    const detail = client.stringDetail('dark-mode', CONTEXT, 'fallback');
    expect(detail.reason).toBe('SDK_DEFAULT');
    expect(detail.errorKind).toBe('CLIENT_NOT_READY');
    expect(detail.stale).toBe(true);
  });

  it('recovers on its own once the backend comes back', async () => {
    const server = new MockServer({ bootstrapStatus: 503, bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { mode: 'polling', pollIntervalMs: 20 });
    await client.start();
    expect(client.status).toBe('ERROR');

    server.bootstrapStatus = 200;
    await waitFor(() => client.status === 'READY');
    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(true);
  });

  it('reports an unknown flag as SDK_DEFAULT, not an error', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { mode: 'polling' });
    await client.start();

    const detail = client.stringDetail('no-such-flag', CONTEXT, 'caller-default');
    expect(detail.value).toBe('caller-default');
    expect(detail.reason).toBe('SDK_DEFAULT');
    expect(detail.errorKind).toBe('FLAG_NOT_FOUND');
  });

  it('rejects a blank context key instead of substituting one', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { mode: 'polling' });
    await client.start();

    const detail = client.stringDetail('dark-mode', { key: '   ' }, 'caller-default');
    expect(detail.value).toBe('caller-default');
    expect(detail.errorKind).toBe('INVALID_CONTEXT');
  });

  it('seeds from initialBootstrap so the first evaluation is never a default', async () => {
    const server = new MockServer({ bootstrapNetworkError: true, streamStatus: 500 });
    const client = makeClient(server, {
      initialBootstrap: bootstrapWith([booleanFlag('dark-mode')]),
    });
    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(true);
    await client.start();
    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(true);
  });
});

describe('streaming', () => {
  it('applies a put event as a full replace', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server);
    await client.start();
    const stream = await server.nextStream();

    stream.send('put', bootstrapWith([booleanFlag('brand-new')], [], 9), 9);
    await waitFor(() => client.stateVersion === 9);

    expect(client.booleanValue('brand-new', CONTEXT, false)).toBe(true);
    // A put replaces everything, so the old flag is gone.
    expect(client.stringDetail('dark-mode', CONTEXT, 'x').errorKind).toBe('FLAG_NOT_FOUND');
  });

  it('applies a patch to exactly one flag and leaves the others alone', async () => {
    const server = new MockServer({
      bootstrap: bootstrapWith([booleanFlag('dark-mode'), booleanFlag('legacy-search')]),
    });
    const client = makeClient(server);
    await client.start();
    const stream = await server.nextStream();

    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(true);
    expect(client.booleanValue('legacy-search', CONTEXT, false)).toBe(true);

    const killed = booleanFlag('dark-mode', { killSwitchActive: true });
    stream.send('patch', patchFor(killed, 7), 7);
    await waitFor(() => client.stateVersion === 7);

    const detail = client.booleanDetail('dark-mode', CONTEXT, true);
    expect(detail.value).toBe(false);
    expect(detail.reason).toBe('KILL_SWITCH');
    // The other flag is untouched, and the patched flag kept its variations.
    expect(client.booleanValue('legacy-search', CONTEXT, false)).toBe(true);
    expect(detail.variationId).toBe(FALSE_VARIATION);
  });

  it('emits change with just the patched flag key', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server);
    const changes: string[][] = [];
    client.on('change', ({ flagKeys }) => changes.push(flagKeys));
    await client.start();
    const stream = await server.nextStream();

    stream.send('patch', patchFor(booleanFlag('dark-mode', { enabled: false }), 4), 4);
    await waitFor(() => changes.some((keys) => keys.length === 1 && keys[0] === 'dark-mode'));
  });

  it('resyncs from bootstrap when a patch names a flag it has never seen', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server);
    await client.start();
    const stream = await server.nextStream();
    const before = server.requestsTo('/api/eval/bootstrap').length;

    // A patch has no variations or kind, so an unknown flag cannot be built from it.
    server.bootstrap = bootstrapWith([booleanFlag('dark-mode'), booleanFlag('surprise')], [], 12);
    stream.send('patch', patchFor(booleanFlag('surprise'), 12), 12);

    await waitFor(() => server.requestsTo('/api/eval/bootstrap').length > before);
    await waitFor(() => client.booleanValue('surprise', CONTEXT, false));
  });

  it('reconnects with Last-Event-ID after the stream drops', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server);
    await client.start();
    const stream = await server.waitForStreamCount(1);

    stream.send('put', bootstrapWith([booleanFlag('dark-mode')], [], 42), 42);
    await waitFor(() => client.stateVersion === 42);

    stream.close();
    await server.waitForStreamCount(2, 5_000);

    const streamRequests = server.requestsTo('/api/stream');
    expect(streamRequests.length).toBeGreaterThanOrEqual(2);
    expect(streamRequests[0]?.headers['last-event-id']).toBe('1');
    expect(streamRequests[1]?.headers['last-event-id']).toBe('42');
  });

  it('keeps serving the last known config while the stream is down', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { staleAfterMs: 50 });
    await client.start();
    const stream = await server.waitForStreamCount(1);

    server.streamStatus = 503;
    stream.close();
    await waitFor(() => client.status === 'STALE', 3_000);

    // Still answers, still from real config, and says so.
    const detail = client.booleanDetail('dark-mode', CONTEXT, false);
    expect(detail.value).toBe(true);
    expect(detail.reason).toBe('DEFAULT');
    expect(detail.stale).toBe(true);
  });

  it('stops reconnecting when the SDK key is rejected', async () => {
    const server = new MockServer({ bootstrapStatus: 401, streamStatus: 401 });
    const client = makeClient(server);
    const errors: boolean[] = [];
    client.on('error', ({ willRetry }) => errors.push(willRetry));
    await client.start();

    await waitFor(() => errors.includes(false), 3_000);
    const attempts = server.requestsTo('/api/stream').length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.requestsTo('/api/stream').length).toBe(attempts);
  });

  it('treats a ping as liveness without disturbing the config', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { staleAfterMs: 0 });
    await client.start();
    const stream = await server.nextStream();
    const versionBefore = client.stateVersion;

    stream.ping();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.stateVersion).toBe(versionBefore);
    expect(client.status).toBe('READY');
  });

  it('survives a malformed stream frame', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server);
    await client.start();
    const stream = await server.nextStream();

    stream.raw('event:put\ndata:{not json\n\n');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(true);

    stream.send('patch', patchFor(booleanFlag('dark-mode', { enabled: false }), 5), 5);
    await waitFor(() => client.stateVersion === 5);
    expect(client.booleanValue('dark-mode', CONTEXT, true)).toBe(false);
  });
});

describe('polling mode', () => {
  it('sends If-None-Match and treats 304 as "still current"', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { mode: 'polling', pollIntervalMs: 20 });
    await client.start();

    await waitFor(() => server.requestsTo('/api/eval/bootstrap').length >= 3);
    const requests = server.requestsTo('/api/eval/bootstrap');
    expect(requests[0]?.headers['if-none-match']).toBeUndefined();
    expect(requests[1]?.headers['if-none-match']).toBe('"1"');
    // 304s keep the client READY rather than resetting it.
    expect(client.status).toBe('READY');
    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(true);
    expect(server.requestsTo('/api/stream')).toHaveLength(0);
  });

  it('picks up a new state version on the next poll', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { mode: 'polling', pollIntervalMs: 20 });
    await client.start();

    server.bootstrap = bootstrapWith([booleanFlag('dark-mode', { enabled: false })], [], 2);
    await waitFor(() => client.stateVersion === 2);
    expect(client.booleanDetail('dark-mode', CONTEXT, true).reason).toBe('FLAG_OFF');
  });
});

describe('resilience of the evaluation path itself', () => {
  it('serves the default for a config that points at a deleted variation', async () => {
    const broken = booleanFlag('broken', {
      config: {
        individualTargets: [],
        rules: [],
        fallthrough: { variationId: 'deadbeef-0000-4000-8000-000000000000', rollout: [] },
        offVariationId: FALSE_VARIATION,
        defaultVariationId: TRUE_VARIATION,
      },
    });
    const server = new MockServer({ bootstrap: bootstrapWith([broken]) });
    const client = makeClient(server, { mode: 'polling' });
    await client.start();

    const detail = client.stringDetail('broken', CONTEXT, 'safe');
    expect(detail.value).toBe('safe');
    expect(detail.errorKind).toBe('CONFIG_UNREADABLE');
  });

  it('refuses a rollout whose weights do not sum to 100 rather than rescaling it', async () => {
    const broken = booleanFlag('bad-weights', {
      config: {
        individualTargets: [],
        rules: [],
        fallthrough: {
          variationId: null,
          rollout: [
            { variationId: TRUE_VARIATION, weight: 50 },
            { variationId: FALSE_VARIATION, weight: 40 },
          ],
        },
        offVariationId: FALSE_VARIATION,
        defaultVariationId: TRUE_VARIATION,
      },
    });
    const server = new MockServer({ bootstrap: bootstrapWith([broken]) });
    const client = makeClient(server, { mode: 'polling' });
    await client.start();

    const detail = client.booleanDetail('bad-weights', CONTEXT, false);
    expect(detail.value).toBe(false);
    expect(detail.errorKind).toBe('CONFIG_UNREADABLE');
  });

  it('never lets a throwing event listener escape', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { mode: 'polling' });
    client.on('ready', () => {
      throw new Error('listener blew up');
    });
    await expect(client.start()).resolves.toBeUndefined();
    expect(client.status).toBe('READY');
  });

  it('is safe to close twice and to evaluate after closing', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server);
    await client.start();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
    expect(client.booleanValue('dark-mode', CONTEXT, false)).toBe(true);
  });
});

describe('typed accessors', () => {
  it('parses numbers and JSON, and falls back with PARSE_ERROR when it cannot', async () => {
    const stringFlag = {
      key: 'tunables',
      kind: 'STRING' as const,
      variations: [{ id: TRUE_VARIATION, value: 'not-a-number', name: 'Broken' }],
      enabled: true,
      killSwitchActive: false,
      config: {
        individualTargets: [],
        rules: [],
        fallthrough: { variationId: TRUE_VARIATION, rollout: [] },
        offVariationId: TRUE_VARIATION,
        defaultVariationId: TRUE_VARIATION,
      },
      version: 1,
    };
    const server = new MockServer({ bootstrap: bootstrapWith([stringFlag]) });
    const client = makeClient(server, { mode: 'polling' });
    await client.start();

    const asNumber = client.numberDetail('tunables', CONTEXT, 7);
    expect(asNumber.value).toBe(7);
    expect(asNumber.errorKind).toBe('PARSE_ERROR');

    const asJson = client.jsonDetail('tunables', CONTEXT, { fallback: true });
    expect(asJson.value).toEqual({ fallback: true });
    expect(asJson.errorKind).toBe('PARSE_ERROR');

    // The raw string is still available and is not an error.
    expect(client.stringDetail('tunables', CONTEXT, '').value).toBe('not-a-number');
  });

  it('allFlags evaluates every known flag', async () => {
    const server = new MockServer({
      bootstrap: bootstrapWith([booleanFlag('a'), booleanFlag('b', { enabled: false })]),
    });
    const client = makeClient(server, { mode: 'polling' });
    await client.start();

    const all = client.allFlags(CONTEXT);
    expect(Object.keys(all).sort()).toEqual(['a', 'b']);
    expect(all['a']?.reason).toBe('DEFAULT');
    expect(all['b']?.reason).toBe('FLAG_OFF');
  });
});

describe('configuration', () => {
  it('rejects a missing sdkKey at construction, the one place throwing is allowed', () => {
    expect(() => new SwitchboardClient({ sdkKey: '' })).toThrow(/sdkKey/);
  });

  it('does not hold the process open with its timers', async () => {
    const server = new MockServer();
    const client = makeClient(server, { mode: 'polling', pollIntervalMs: 20 });
    await client.start();
    const timer = setTimeout(() => undefined, 0);
    expect(typeof (timer as unknown as { unref?: () => void }).unref).toBe('function');
    clearTimeout(timer);
    vi.clearAllTimers();
  });
});

describe('reconnect backoff', () => {
  it('grows exponentially and is clamped to the ceiling', () => {
    // random() pinned at its maximum isolates the growth curve from the jitter.
    const backoff = new Backoff({
      initialMs: 100,
      maxMs: 1_000,
      factor: 2,
      random: () => 0.999_999,
    });
    const delays = [0, 1, 2, 3, 4, 5, 6].map(() => backoff.next());
    expect(delays).toEqual([99, 199, 399, 799, 999, 999, 999]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1_000);

    backoff.reset();
    expect(backoff.next()).toBe(99);
  });

  it('jitters, so a fleet of SDKs does not reconnect in lockstep', () => {
    const seen = new Set<number>();
    for (let instance = 0; instance < 200; instance += 1) {
      const backoff = new Backoff({ ...DEFAULT_BACKOFF });
      backoff.next();
      backoff.next();
      seen.add(backoff.next());
    }
    // Third attempt without jitter would be exactly 4000ms for every one of them.
    expect(seen.size).toBeGreaterThan(50);
    expect(seen.has(4_000)).toBe(false);
    for (const delay of seen) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(4_000);
    }
  });

  it('never exceeds maxMs however many times it has failed', () => {
    const backoff = new Backoff({ ...DEFAULT_BACKOFF, random: () => 0.999_999 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(backoff.next()).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    }
    expect(backoff.attempts).toBe(100);
  });

  it('backs off between stream reconnects rather than hammering the server', async () => {
    const server = new MockServer({
      bootstrap: bootstrapWith([booleanFlag('dark-mode')]),
      streamStatus: 503,
    });
    const client = makeClient(server);
    await client.start();

    await waitFor(() => server.requestsTo('/api/stream').length >= 1, 3_000);
    const afterFirst = server.requestsTo('/api/stream').length;
    // The first backoff step is up to a second; a hot loop would fire hundreds of times here.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.requestsTo('/api/stream').length - afterFirst).toBeLessThan(5);
  });
});

describe('a backend that is simply not there', () => {
  // No mock: a real fetch against a closed port, which is what a host application hits when the
  // Switchboard API is down, misconfigured or firewalled off.
  const DEAD = 'http://127.0.0.1:1';

  it('starts, evaluates and closes without ever throwing', async () => {
    const client = makeClient(new MockServer(), {
      baseUrl: DEAD,
      fetch: globalThis.fetch as FetchLike,
      bootstrapTimeoutMs: 1_000,
    });

    await expect(client.start()).resolves.toBeUndefined();
    expect(client.status).toBe('ERROR');

    expect(client.booleanValue('dark-mode', CONTEXT, true)).toBe(true);
    expect(client.stringValue('dark-mode', CONTEXT, 'fallback')).toBe('fallback');
    expect(client.numberValue('dark-mode', CONTEXT, 3)).toBe(3);
    expect(client.jsonValue('dark-mode', CONTEXT, { ok: false })).toEqual({ ok: false });
    expect(client.allFlags(CONTEXT)).toEqual({});
    expect(() => client.track('checkout.completed', 'user-1')).not.toThrow();

    const detail = client.booleanDetail('dark-mode', CONTEXT, false);
    expect(detail.reason).toBe('SDK_DEFAULT');
    expect(detail.errorKind).toBe('CLIENT_NOT_READY');

    await expect(client.waitForInitialization(50)).resolves.toBe(false);
    await expect(client.flush()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('degrades to the last known config rather than to defaults when it has one', async () => {
    const client = makeClient(new MockServer(), {
      baseUrl: DEAD,
      fetch: globalThis.fetch as FetchLike,
      bootstrapTimeoutMs: 1_000,
      // A snapshot persisted by a previous process: the backend being down at boot is survivable.
      initialBootstrap: bootstrapWith([booleanFlag('dark-mode')]),
    });

    await expect(client.start()).resolves.toBeUndefined();
    const detail = client.booleanDetail('dark-mode', CONTEXT, false);
    expect(detail.value).toBe(true);
    expect(detail.reason).toBe('DEFAULT');
    expect(detail.errorKind).toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });
});
