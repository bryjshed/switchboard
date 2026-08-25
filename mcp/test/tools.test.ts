import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SwitchboardClient } from '../src/client.js';
import { TOOLS } from '../src/tools.js';
import { zodToJsonSchema } from '../src/schema.js';

function clientReturning(status: number, body: unknown, seen: unknown[] = []) {
  return new SwitchboardClient({
    baseUrl: 'http://example.test',
    token: 'sb_pat_test',
    fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method, body: init?.body });
      return new Response(status === 204 ? '' : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch,
  });
}

const updateTargeting = TOOLS.find((t) => t.name === 'update_targeting')!;

describe('the 202 distinction', () => {
  it('reports an applied write as applied', async () => {
    const client = clientReturning(200, { version: 5 });
    const result = (await updateTargeting.run(client, {
      projectId: 'p', flagKey: 'f', envKey: 'production',
      enabled: true, config: {}, expectedVersion: 4,
    } as never)) as Record<string, unknown>;

    expect(result['applied']).toBe(true);
  });

  it('never lets a QUEUED write read as success', async () => {
    // This is the failure that matters: a gated environment answers 202 and changes nothing. An
    // agent that reports "done" here tells its user a rollout happened when it did not.
    const client = clientReturning(202, { id: 'cr-1', status: 'PENDING' });
    const result = (await updateTargeting.run(client, {
      projectId: 'p', flagKey: 'f', envKey: 'production',
      enabled: true, config: {}, expectedVersion: 4,
    } as never)) as Record<string, unknown>;

    expect(result['applied']).toBe(false);
    expect(result['queued']).toBe(true);
    expect(String(result['summary'])).toContain('NOT applied');
    expect(String(result['summary'])).toContain('Do not report it as done');
    expect(result['changeRequest']).toEqual({ id: 'cr-1', status: 'PENDING' });
  });

  it('explains a version conflict in terms of what to do about it', async () => {
    const client = clientReturning(409, { message: 'stale' });
    await expect(
      updateTargeting.run(client, {
        projectId: 'p', flagKey: 'f', envKey: 'production',
        enabled: true, config: {}, expectedVersion: 1,
      } as never),
    ).rejects.toThrow(/re-read it and retry/);
  });
});

describe('tool schemas', () => {
  it('every tool advertises a valid object schema', () => {
    for (const tool of TOOLS) {
      const schema = zodToJsonSchema(tool.schema);
      expect(schema['type'], tool.name).toBe('object');
      expect(schema['properties'], tool.name).toBeDefined();
    }
  });

  it('marks optional arguments optional and required ones required', () => {
    const listFlags = TOOLS.find((t) => t.name === 'list_flags')!;
    const schema = zodToJsonSchema(listFlags.schema);
    expect(schema['required']).toEqual(['projectId']);
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['limit']?.['type']).toBe('integer');
    expect(props['query']?.['description']).toContain('Substring');
  });

  it('refuses to emit an untyped schema for something it does not understand', () => {
    // A tool whose arguments quietly become "any object" is one a model calls wrongly and
    // confidently, so this fails loudly at build time instead.
    expect(() => zodToJsonSchema(z.object({ when: z.date() }))).toThrow(/Unsupported schema type/);
  });

  it('every tool has a name and a description a model can choose from', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});
