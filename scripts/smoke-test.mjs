#!/usr/bin/env node
// Switchboard API smoke suite. Plain Node, no deps. Dev-token auth, per-run unique emails.
// Usage: node scripts/smoke-test.mjs   (backend must be running on :28080 with local profile)
// Exit 0 = all pass, 1 = any failure.

import http from 'node:http';
import crypto from 'node:crypto';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:28080';
const run = Math.random().toString(36).slice(2, 8);
const OWNER = `smoke-owner-${run}@ex.com`;
const MEMBER = `smoke-member-${run}@ex.com`;
const STRANGER = `smoke-stranger-${run}@ex.com`;

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

const dev = (email) => `dev:${email}`;

async function main() {
  console.log(`Switchboard smoke suite — run ${run}\n`);

  // --- Auth ---
  let r = await req('GET', '/api/users/me', { token: dev(OWNER) });
  check('me auto-provisions (200)', r.status === 200 && r.json?.email === OWNER);
  r = await req('GET', '/api/users/me');
  check('401 without token', r.status === 401);
  r = await req('GET', '/api/users/me', { token: 'garbage-token' });
  check('401 with garbage token', r.status === 401);
  await req('GET', '/api/users/me', { token: dev(MEMBER) });
  await req('GET', '/api/users/me', { token: dev(STRANGER) });

  // --- Org & project topology ---
  r = await req('POST', '/api/orgs', { token: dev(OWNER), body: { name: `Smoke Org ${run}` } });
  check('org create (201, OWNER)', r.status === 201 && r.json?.role === 'OWNER');
  const orgId = r.json?.id;

  r = await req('POST', `/api/orgs/${orgId}/projects`, { token: dev(OWNER), body: { key: 'smoke-app', name: 'Smoke App' } });
  check('project create seeds 3 envs', r.status === 201 && r.json?.environments?.length === 3);
  const projectId = r.json?.id;
  const prod = r.json?.environments?.find((e) => e.key === 'production');

  r = await req('GET', `/api/orgs/${orgId}/members`, { token: dev(STRANGER) });
  check('403 non-member org access', r.status === 403);

  r = await req('POST', `/api/orgs/${orgId}/members`, { token: dev(OWNER), body: { email: MEMBER, role: 'MEMBER' } });
  check('member add by email (201)', r.status === 201);
  r = await req('POST', `/api/orgs/${orgId}/members`, { token: dev(MEMBER), body: { email: STRANGER, role: 'MEMBER' } });
  check('403 member performing owner action', r.status === 403);

  r = await req('POST', `/api/environments/${prod.id}/sdk-keys`, { token: dev(OWNER), body: { label: 'smoke' } });
  check('sdk key minted with full key once', r.status === 201 && typeof r.json?.key === 'string' && r.json.key.startsWith('sb_srv_'));
  const sdkKey = r.json?.key;
  const sdkKeyId = r.json?.id;

  // --- Flags ---
  r = await req('POST', `/api/projects/${projectId}/flags`, {
    token: dev(OWNER),
    body: { key: 'smoke-checkout', name: 'Smoke Checkout', kind: 'BOOLEAN' },
  });
  check('boolean flag create (201, 3 env configs v1)', r.status === 201 && r.json?.envConfigs?.length === 3 && r.json.envConfigs.every((c) => c.version === 1));
  const flag = r.json;
  const trueVar = flag?.variations?.find((v) => v.value === 'true');
  const falseVar = flag?.variations?.find((v) => v.value === 'false');

  r = await req('POST', `/api/projects/${projectId}/flags`, { token: dev(OWNER), body: { key: 'Bad Key!', name: 'x', kind: 'BOOLEAN' } });
  check('400 invalid flag key', r.status === 400);

  const ramp = (pctTrue, expectedVersion) => ({
    enabled: true,
    expectedVersion,
    comment: `ramp ${pctTrue}`,
    config: {
      individualTargets: [],
      rules: [],
      fallthrough: { rollout: [ { variationId: trueVar.id, weight: pctTrue }, { variationId: falseVar.id, weight: 100 - pctTrue } ] },
      offVariationId: falseVar.id,
      defaultVariationId: trueVar.id,
    },
  });

  r = await req('PUT', `/api/projects/${projectId}/flags/smoke-checkout/environments/production`, { token: dev(OWNER), body: ramp(25, 1) });
  check('targeting update → v2', r.status === 200 && r.json?.version === 2);

  r = await req('PUT', `/api/projects/${projectId}/flags/smoke-checkout/environments/production`, { token: dev(OWNER), body: ramp(50, 1) });
  check('409 stale expectedVersion', r.status === 409);

  const badWeights = ramp(25, 2);
  badWeights.config.fallthrough.rollout[1].weight = 65; // sums to 90
  r = await req('PUT', `/api/projects/${projectId}/flags/smoke-checkout/environments/production`, { token: dev(OWNER), body: badWeights });
  check('400 rollout weights != 100', r.status === 400);

  // --- Evaluation ---
  r = await req('POST', '/api/eval/smoke-checkout', { token: sdkKey, body: { context: { key: 'user-1' } } });
  check('single eval (200)', r.status === 200 && ['true', 'false'].includes(r.json?.value));
  const first = r.json?.value;
  r = await req('POST', '/api/eval/smoke-checkout', { token: sdkKey, body: { context: { key: 'user-1' } } });
  check('bucket stickiness (same key, same value)', r.status === 200 && r.json?.value === first);

  r = await req('POST', '/api/eval/unknown-flag', { token: sdkKey, body: { context: { key: 'user-1' }, default: 'fallback-x' } });
  check('unknown flag → 200 + SDK default (the fail-safe)', r.status === 200 && r.json?.value === 'fallback-x' && r.json?.reason === 'SDK_DEFAULT');

  r = await req('POST', '/api/eval', { token: sdkKey, body: { context: { key: 'user-2' } } });
  check('bulk eval carries stateVersion + results', r.status === 200 && typeof r.json?.stateVersion === 'number' && Array.isArray(r.json?.results));

  r = await req('GET', '/api/eval/bootstrap', { token: sdkKey });
  const etag = r.headers.get('etag');
  check('bootstrap 200 with ETag', r.status === 200 && !!etag);
  r = await req('GET', '/api/eval/bootstrap', { token: sdkKey, headers: { 'If-None-Match': etag } });
  check('bootstrap 304 on matching If-None-Match', r.status === 304);

  r = await req('POST', '/api/eval', { token: dev(OWNER), body: { context: { key: 'u' } } });
  check('403 user bearer on SDK surface', r.status === 403);
  r = await req('GET', `/api/orgs/${orgId}`, { token: sdkKey });
  check('403 SDK key on management surface', r.status === 403);

  // --- Kill switch / rollback / audit ---
  r = await req('POST', `/api/projects/${projectId}/flags/smoke-checkout/environments/production/kill-switch`, { token: dev(OWNER), body: { active: true, reason: 'smoke kill' } });
  check('kill switch on (200)', r.status === 200 && r.json?.killSwitchActive === true);
  r = await req('POST', '/api/eval/smoke-checkout', { token: sdkKey, body: { context: { key: 'user-1' } } });
  check('eval serves off variation under kill switch', r.json?.value === 'false' && r.json?.reason === 'KILL_SWITCH');

  r = await req('POST', `/api/projects/${projectId}/flags/smoke-checkout/environments/production/rollback`, { token: dev(OWNER), body: { toVersion: 1, reason: 'smoke rollback' } });
  check('rollback → new version', r.status === 200 && r.json?.version > 3);
  r = await req('POST', '/api/eval/smoke-checkout', { token: sdkKey, body: { context: { key: 'user-1' } } });
  check('post-rollback eval FLAG_OFF', r.json?.reason === 'FLAG_OFF');

  r = await req('GET', `/api/projects/${projectId}/flags/smoke-checkout/environments/production/versions`, { token: dev(OWNER) });
  check('version history present', r.status === 200 && (r.json?.items?.length ?? 0) >= 4);

  r = await req('GET', `/api/projects/${projectId}/audit`, { token: dev(OWNER) });
  const actions = (r.json?.items ?? []).map((a) => a.action);
  check('audit shows CREATE/UPDATE/KILL_SWITCH_ON/ROLLBACK', ['CREATE', 'UPDATE', 'KILL_SWITCH_ON', 'ROLLBACK'].every((a) => actions.includes(a)), actions.join(','));

  // --- Segments ---
  r = await req('POST', `/api/projects/${projectId}/segments`, { token: dev(OWNER), body: { key: 'smoke-beta', name: 'Smoke Beta', includedKeys: ['user-7'] } });
  check('segment create (201)', r.status === 201);

  // --- Events ---
  r = await req('POST', '/api/events/eval', { token: sdkKey, body: { events: [ { flagKey: 'smoke-checkout', contextKey: 'user-1', reason: 'ROLLOUT', occurredAt: new Date().toISOString() } ] } });
  check('eval events ingest (202)', r.status === 202);
  r = await req('POST', '/api/events/metrics', { token: sdkKey, body: { events: [ { contextKey: 'user-1', metricKey: 'error', value: 1, occurredAt: new Date().toISOString() } ] } });
  check('metric events ingest (202)', r.status === 202);

  // --- Signed webhooks ---
  // Verifying the signature HERE, in Node, is the point: the server signs in Java, and a
  // receiver is whatever language the customer writes. A Java-only test would prove the
  // signer agrees with itself. This proves the documented recipe is reproducible.
  const hookEvents = [];
  const receiver = http.createServer((req2, res) => {
    let body = '';
    req2.on('data', (c) => { body += c; });
    req2.on('end', () => {
      hookEvents.push({ body, headers: req2.headers });
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  r = await req('POST', `/api/orgs/${orgId}/webhooks`, {
    token: dev(OWNER),
    body: { url: hookUrl, description: 'smoke', eventTypes: ['flag.updated', 'flag.kill_switch'] },
  });
  check('webhook create returns the secret once', r.status === 201 && typeof r.json?.secret === 'string' && r.json.secret.startsWith('whsec_'));
  const hookSecret = r.json?.secret;
  const hookId = r.json?.id;

  r = await req('GET', `/api/orgs/${orgId}/webhooks`, { token: dev(OWNER) });
  check('webhook list omits the secret', r.status === 200 && r.json?.[0] && r.json[0].secret === undefined);

  r = await req('POST', `/api/orgs/${orgId}/webhooks`, { token: dev(OWNER), body: { url: 'ftp://nope.example/x' } });
  check('400 non-http webhook url', r.status === 400);

  // Cause an event, then wait for the delivery to land.
  await req('PUT', `/api/projects/${projectId}/flags/smoke-checkout/environments/dev`, {
    token: dev(OWNER),
    body: { enabled: true, expectedVersion: 1, comment: 'webhook trigger', config: {
      individualTargets: [], rules: [],
      fallthrough: { variationId: trueVar.id },
      offVariationId: falseVar.id, defaultVariationId: trueVar.id } },
  });
  for (let i = 0; i < 100 && hookEvents.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('webhook delivered a flag.updated event', hookEvents.length > 0 && hookEvents[0].headers['x-switchboard-event'] === 'flag.updated');

  if (hookEvents.length > 0) {
    const { body, headers } = hookEvents[0];
    const header = headers['x-switchboard-signature'] ?? '';
    const t = /t=(\d+)/.exec(header)?.[1];
    const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1];
    const expected = crypto.createHmac('sha256', hookSecret).update(`${t}.${body}`).digest('hex');
    check('signature verifies in Node with the documented recipe',
      !!t && !!v1 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)));
    check('signature is bound to the body (tamper fails)',
      crypto.createHmac('sha256', hookSecret).update(`${t}.${body} `).digest('hex') !== v1);
    const parsed = JSON.parse(body);
    check('delivery payload carries type + flagKey + a dedupe id',
      parsed.type === 'flag.updated' && parsed.data?.flagKey === 'smoke-checkout' && typeof parsed.id === 'string');
  }

  r = await req('GET', `/api/webhooks/${hookId}/deliveries`, { token: dev(OWNER) });
  check('webhook deliveries are listable', r.status === 200 && Array.isArray(r.json) && r.json.length >= 1);

  r = await req('GET', `/api/webhooks/${hookId}/deliveries`, { token: dev(STRANGER) });
  check('403 another org cannot read deliveries', r.status === 403);

  r = await req('DELETE', `/api/webhooks/${hookId}`, { token: dev(OWNER) });
  check('webhook delete (204)', r.status === 204);
  receiver.close();

  // --- SDK key revocation ---
  r = await req('DELETE', `/api/sdk-keys/${sdkKeyId}`, { token: dev(OWNER) });
  check('sdk key revoke (204)', r.status === 204);
  r = await req('POST', '/api/eval', { token: sdkKey, body: { context: { key: 'u' } } });
  check('401 revoked sdk key', r.status === 401);

  // --- 404s ---
  r = await req('GET', `/api/projects/${projectId}/flags/never-existed`, { token: dev(OWNER) });
  check('404 unknown flag (management)', r.status === 404);

  // --- AI (tolerant: keyless envs skip-with-warning) ---
  r = await req('POST', `/api/projects/${projectId}/ai/proposals`, { token: dev(OWNER), body: { prompt: 'Turn smoke-checkout fully on in dev' } });
  if (r.status === 503) {
    console.log('  skip AI proposal draft (503 AI_UNAVAILABLE — keyless env)');
  } else {
    check('AI proposal drafted (201, typed diff)', r.status === 201 && r.json?.diff?.flagKey, JSON.stringify(r.json).slice(0, 120));
    if (r.status === 201) {
      const apply = await req('POST', `/api/ai/proposals/${r.json.id}/apply`, { token: dev(OWNER), body: {} });
      check('AI proposal apply (200 APPLIED)', apply.status === 200 && apply.json?.status === 'APPLIED');
      const dup = await req('POST', `/api/ai/proposals/${r.json.id}/apply`, { token: dev(OWNER), body: {} });
      check('409 double-apply proposal', dup.status === 409);
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failures:', failures.join(' | '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Smoke suite crashed:', e);
  process.exit(1);
});
