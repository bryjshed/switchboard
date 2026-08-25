import { describe, expect, it } from 'vitest';
import { SwitchboardClient } from '../src/client/client.js';
import { SwitchboardConfigError, resolveConfig } from '../src/client/config.js';
import type { ClientBootstrapResponse } from '../src/types.js';

/**
 * Client mode: the SDK holds evaluated values rather than rules.
 *
 * The invariant worth protecting is that the mode is DERIVED from the key, not configured. There is
 * deliberately no `mode: 'client'` option, because a config that says "client" while holding a
 * server key (or the reverse) is a real mistake that would otherwise be representable.
 */
describe('client mode', () => {
  const CLIENT_KEY = 'sb_cli_production_deadbeef';
  const SERVER_KEY = 'sb_srv_production_deadbeef';
  const CONTEXT = { key: 'user-1', attributes: { plan: 'pro' } };

  function payload(overrides: Partial<ClientBootstrapResponse> = {}): ClientBootstrapResponse {
    return {
      envKey: 'production',
      stateVersion: 7,
      contextHash: 'abc123',
      flags: [
        {
          key: 'new-checkout',
          kind: 'BOOLEAN',
          value: 'true',
          variationId: '0a0a0a0a-0000-0000-0000-000000000001',
          variationName: 'On',
          reason: 'ROLLOUT',
          ruleId: null,
          version: 3,
        },
      ],
      ...overrides,
    };
  }

  function stubFetch(body: ClientBootstrapResponse, seen: Request[] = []) {
    return async (input: string, init?: RequestInit) => {
      seen.push({ url: input, init } as unknown as Request);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"digest"' },
      });
    };
  }

  it('derives the mode from the key prefix rather than a flag', () => {
    expect(resolveConfig({ sdkKey: CLIENT_KEY, context: CONTEXT }).keyKind).toBe('client');
    expect(resolveConfig({ sdkKey: SERVER_KEY }).keyKind).toBe('server');
    expect(resolveConfig({ sdkKey: 'sb_mob_production_x', context: CONTEXT }).keyKind).toBe('client');
  });

  it('refuses the two configurations that cannot work', () => {
    // A client key with nothing to evaluate for.
    expect(() => resolveConfig({ sdkKey: CLIENT_KEY })).toThrow(SwitchboardConfigError);
    // A server key with a fixed context, which would silently be ignored per evaluation.
    expect(() => resolveConfig({ sdkKey: SERVER_KEY, context: CONTEXT })).toThrow(
      SwitchboardConfigError,
    );
    // A rule-set snapshot cannot seed a client store.
    expect(() =>
      resolveConfig({
        sdkKey: CLIENT_KEY,
        context: CONTEXT,
        initialBootstrap: { envKey: 'production', stateVersion: 1, flags: [], segments: [] },
      }),
    ).toThrow(SwitchboardConfigError);
  });

  it('POSTs the context and serves the value the server computed', async () => {
    const seen: Request[] = [];
    const client = new SwitchboardClient({
      sdkKey: CLIENT_KEY,
      context: CONTEXT,
      mode: 'polling',
      telemetry: false,
      fetch: stubFetch(payload(), seen),
    });
    await client.start();

    const request = seen[0] as unknown as { url: string; init: RequestInit };
    expect(request.url).toContain('/api/eval/bootstrap');
    expect(request.init.method).toBe('POST');
    expect(JSON.parse(String(request.init.body))).toEqual({ context: CONTEXT });

    const detail = client.booleanDetail('new-checkout', undefined, false);
    expect(detail.value).toBe(true);
    expect(detail.reason).toBe('ROLLOUT');
    expect(detail.variationName).toBe('On');
    await client.close();
  });

  it('serves the caller default for a flag the key cannot see', async () => {
    const client = new SwitchboardClient({
      sdkKey: CLIENT_KEY,
      context: CONTEXT,
      mode: 'polling',
      telemetry: false,
      fetch: stubFetch(payload()),
    });
    await client.start();

    // Hidden and genuinely-unknown are deliberately indistinguishable: both are simply absent from
    // the payload, and both serve the default rather than confirming the flag exists.
    const detail = client.stringDetail('secret-flag', undefined, 'fallback');
    expect(detail.value).toBe('fallback');
    expect(detail.errorKind).toBe('FLAG_NOT_FOUND');
    await client.close();
  });

  it('setContext refetches and drops the stale ETag', async () => {
    const seen: Request[] = [];
    const client = new SwitchboardClient({
      sdkKey: CLIENT_KEY,
      context: CONTEXT,
      mode: 'polling',
      telemetry: false,
      fetch: stubFetch(payload(), seen),
    });
    await client.start();
    await client.setContext({ key: 'user-2', attributes: { plan: 'free' } });

    const second = seen[1] as unknown as { init: RequestInit };
    expect(JSON.parse(String(second.init.body)).context.key).toBe('user-2');
    // Carrying the old ETag would earn a 304 for a payload evaluated against the OLD context, and
    // strand the client on the previous user's answers.
    expect((second.init.headers as Record<string, string>)['If-None-Match']).toBeUndefined();
    await client.close();
  });

  it('setContext is refused on a server key', async () => {
    const client = new SwitchboardClient({ sdkKey: SERVER_KEY, mode: 'polling', telemetry: false });
    await expect(client.setContext({ key: 'user-2' })).rejects.toThrow(SwitchboardConfigError);
    await client.close();
  });

  it('an empty payload is a warning, not a failure', async () => {
    const warnings: string[] = [];
    const client = new SwitchboardClient({
      sdkKey: CLIENT_KEY,
      context: CONTEXT,
      mode: 'polling',
      telemetry: false,
      fetch: stubFetch(payload({ flags: [] })),
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
        error: () => {},
      },
    });
    await client.start();

    // client_side_available is off by default, so a brand-new client key legitimately sees nothing.
    // That reads like a broken integration, so it has to say why.
    expect(warnings.join(' ')).toContain('available to client-side SDKs');
    expect(client.booleanValue('anything', undefined, false)).toBe(false);
    await client.close();
  });
});
