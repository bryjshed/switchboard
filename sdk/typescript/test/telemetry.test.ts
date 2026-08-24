/**
 * Telemetry: the buffer that feeds Switchboard's healing and optimizing loops.
 *
 * The constraints being defended here are the ones that make it safe to leave on by default in a
 * production process: it batches rather than posting per evaluation, it is bounded so an outage
 * cannot turn into an out-of-memory kill, it flushes what it has on shutdown, and it swallows every
 * failure the backend can hand it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SwitchboardClient } from '../src/client/client.js';
import type { FetchLike } from '../src/client/config.js';
import { silentLogger } from '../src/client/logger.js';
import { Telemetry } from '../src/telemetry/telemetry.js';
import { resolveConfig } from '../src/client/config.js';
import { bootstrapWith, booleanFlag, MockServer, type RecordedRequest } from './support/mockServer.js';

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
    mode: 'polling',
    pollIntervalMs: 60_000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

function bodies(requests: RecordedRequest[]): Array<Record<string, unknown[]>> {
  return requests.map((request) => JSON.parse(request.body ?? '{}') as Record<string, unknown[]>);
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

describe('evaluation events', () => {
  it('buffers evaluations and sends them as one batch, not one request each', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { telemetry: { flushIntervalMs: 0 } });
    await client.start();

    for (let index = 0; index < 25; index += 1) {
      client.booleanValue('dark-mode', { key: `user-${index}` }, false);
    }
    expect(client.telemetryStats.queuedEvalEvents).toBe(25);
    expect(server.requestsTo('/api/events/eval')).toHaveLength(0);

    await client.flush();

    const requests = server.requestsTo('/api/events/eval');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers['authorization']).toBe('Bearer sb_srv_test_key');
    const [payload] = bodies(requests);
    expect(payload?.['events']).toHaveLength(25);
    expect(client.telemetryStats.queuedEvalEvents).toBe(0);
    expect(client.telemetryStats.sent).toBe(25);
  });

  it('records what was actually served, so a variation can be attributed later', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { telemetry: { flushIntervalMs: 0 } });
    await client.start();

    client.booleanValue('dark-mode', CONTEXT, false);
    await client.flush();

    const [payload] = bodies(server.requestsTo('/api/events/eval'));
    const event = (payload?.['events'] as Array<Record<string, string>>)[0];
    expect(event?.['flagKey']).toBe('dark-mode');
    expect(event?.['contextKey']).toBe('user-1');
    expect(event?.['reason']).toBe('DEFAULT');
    expect(event?.['variationId']).toBeTruthy();
    expect(Date.parse(String(event?.['occurredAt']))).not.toBeNaN();
  });

  it('splits a backlog into requests no larger than maxBatchSize', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, {
      telemetry: { flushIntervalMs: 0, maxBatchSize: 10 },
    });
    await client.start();

    for (let index = 0; index < 25; index += 1) {
      client.booleanValue('dark-mode', { key: `user-${index}` }, false);
    }
    await client.flush();

    const sizes = bodies(server.requestsTo('/api/events/eval')).map(
      (payload) => (payload['events'] as unknown[]).length,
    );
    expect(sizes).toEqual([10, 10, 5]);
  });

  it('flushes on the interval without anyone asking', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { telemetry: { flushIntervalMs: 20 } });
    await client.start();

    client.booleanValue('dark-mode', CONTEXT, false);
    await waitFor(() => server.requestsTo('/api/events/eval').length >= 1);
  });

  it('is off entirely when disabled', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { telemetry: false });
    await client.start();

    client.booleanValue('dark-mode', CONTEXT, false);
    client.track('checkout.completed', 'user-1');
    await client.flush();

    expect(client.telemetryStats.queuedEvalEvents).toBe(0);
    expect(server.requestsTo('/api/events/')).toHaveLength(0);
  });
});

describe('the bound on the buffer', () => {
  it('drops the oldest events rather than growing without limit', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, {
      telemetry: { flushIntervalMs: 0, maxQueueSize: 5 },
    });
    await client.start();

    for (let index = 0; index < 12; index += 1) {
      client.booleanValue('dark-mode', { key: `user-${index}` }, false);
    }
    expect(client.telemetryStats.queuedEvalEvents).toBe(5);
    expect(client.telemetryStats.dropped).toBe(7);

    await client.flush();
    const [payload] = bodies(server.requestsTo('/api/events/eval'));
    const keys = (payload?.['events'] as Array<Record<string, string>>).map(
      (event) => event['contextKey'],
    );
    // Drop-oldest: the most recent behaviour is what anomaly detection needs to see.
    expect(keys).toEqual(['user-7', 'user-8', 'user-9', 'user-10', 'user-11']);
  });

  it('caps the metric queue the same way', () => {
    const config = resolveConfig({
      sdkKey: 'sb_srv_test_key',
      logger: silentLogger,
      fetch: (async () => new Response(null, { status: 202 })) as FetchLike,
      telemetry: { maxQueueSize: 3, flushIntervalMs: 0 },
    });
    const telemetry = new Telemetry(config);
    for (let index = 0; index < 10; index += 1) {
      telemetry.recordMetric('checkout.completed', `user-${index}`);
    }
    expect(telemetry.stats.queuedMetricEvents).toBe(3);
    expect(telemetry.stats.dropped).toBe(7);
  });
});

describe('metrics', () => {
  it('track() posts to the metrics endpoint with the context key it was given', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { telemetry: { flushIntervalMs: 0 } });
    await client.start();

    client.track('checkout.completed', 'user-1');
    client.track('checkout.revenue', 'user-1', 42.5);
    await client.flush();

    const requests = server.requestsTo('/api/events/metrics');
    expect(requests).toHaveLength(1);
    const [payload] = bodies(requests);
    expect(payload?.['events']).toEqual([
      expect.objectContaining({ metricKey: 'checkout.completed', contextKey: 'user-1', value: 1 }),
      expect.objectContaining({ metricKey: 'checkout.revenue', contextKey: 'user-1', value: 42.5 }),
    ]);
  });

  it('ignores a blank context key instead of sending an unattributable metric', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { telemetry: { flushIntervalMs: 0 } });
    await client.start();

    client.track('checkout.completed', '   ');
    await client.flush();

    expect(server.requestsTo('/api/events/metrics')).toHaveLength(0);
  });
});

describe('shutdown and failure', () => {
  it('flushes what is buffered when the client closes', async () => {
    const server = new MockServer({ bootstrap: bootstrapWith([booleanFlag('dark-mode')]) });
    const client = makeClient(server, { telemetry: { flushIntervalMs: 0 } });
    await client.start();

    client.booleanValue('dark-mode', CONTEXT, false);
    client.track('checkout.completed', 'user-1');
    expect(server.requestsTo('/api/events/')).toHaveLength(0);

    await client.close();

    expect(server.requestsTo('/api/events/eval')).toHaveLength(1);
    expect(server.requestsTo('/api/events/metrics')).toHaveLength(1);
  });

  it('never lets a rejected batch reach the caller, and does not requeue it forever', async () => {
    const server = new MockServer({
      bootstrap: bootstrapWith([booleanFlag('dark-mode')]),
      eventsStatus: 500,
    });
    const client = makeClient(server, { telemetry: { flushIntervalMs: 0 } });
    await client.start();

    client.booleanValue('dark-mode', CONTEXT, false);
    await expect(client.flush()).resolves.toBeUndefined();

    expect(client.telemetryStats.failedFlushes).toBe(1);
    expect(client.telemetryStats.sent).toBe(0);
    // Dropped rather than retried forever: telemetry is best-effort, and an endlessly retried
    // batch is just a slower memory leak.
    expect(client.telemetryStats.queuedEvalEvents).toBe(0);
  });

  it('survives a telemetry endpoint that is not there at all', async () => {
    const client = makeClient(new MockServer(), {
      baseUrl: 'http://127.0.0.1:1',
      fetch: globalThis.fetch as FetchLike,
      telemetry: { flushIntervalMs: 0 },
      initialBootstrap: bootstrapWith([booleanFlag('dark-mode')]),
    });
    await expect(client.start()).resolves.toBeUndefined();

    client.booleanValue('dark-mode', CONTEXT, false);
    client.track('checkout.completed', 'user-1');
    await expect(client.flush()).resolves.toBeUndefined();
    expect(client.telemetryStats.failedFlushes).toBeGreaterThan(0);
  });
});
