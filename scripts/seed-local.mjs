#!/usr/bin/env node
// Switchboard local seed. Drives the PUBLIC API with real Firebase-emulator user tokens,
// so seeding smoke-tests the API and the seed users can log into the app.
// Idempotent: detects a prior seed and exits with reset instructions.
// Usage: node scripts/seed-local.mjs   (deps + backend must be running)

import { execSync } from 'node:child_process';

const API = process.env.API_BASE_URL ?? 'http://localhost:28080';
const EMU = process.env.FIREBASE_EMULATOR_URL ?? 'http://localhost:29099';
const PASSWORD = 'password123';
const JOB_TOKEN = process.env.JOB_TOKEN ?? 'local-job-token';

const ALICE = 'alice@switchboard.dev';
const BOB = 'bob@switchboard.dev';
const CAROL = 'carol@beta.dev';

async function emuToken(email) {
  const body = JSON.stringify({ email, password: PASSWORD, returnSecureToken: true });
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  let r = await fetch(`${EMU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, opts);
  let j = await r.json();
  if (!j.idToken) {
    r = await fetch(`${EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, opts);
    j = await r.json();
  }
  if (!j.idToken) throw new Error(`Cannot obtain emulator token for ${email}: ${JSON.stringify(j)}`);
  return j.idToken;
}

async function api(method, path, token, body, extraHeaders = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

function psql(sql) {
  return execSync(
    `docker exec switchboard-postgres-1 psql -U postgres -d switchboard -tAc ${JSON.stringify(sql)}`,
    { encoding: 'utf8' }
  ).trim();
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const ruleId = () => crypto.randomUUID();  // rules carry server-parsed UUID ids
const varByValue = (flag, value) => {
  const v = flag.variations.find((x) => x.value === value);
  if (!v) throw new Error(`variation ${value} missing on ${flag.key}`);
  return v.id;
};

async function main() {
  console.log('Switchboard seed — Acme Mobile demo workspace\n');
  const alice = await emuToken(ALICE);
  const bob = await emuToken(BOB);
  const carol = await emuToken(CAROL);
  await api('GET', '/api/users/me', alice);
  await api('GET', '/api/users/me', bob);
  await api('GET', '/api/users/me', carol);

  const existing = await api('GET', '/api/orgs', alice);
  if (existing.some((o) => o.slug.startsWith('acme-mobile'))) {
    console.log('Already seeded (org acme-mobile exists for alice@switchboard.dev).');
    console.log('To reset everything: docker compose down -v && docker compose up -d --wait, restart the backend, re-run seed.');
    return;
  }

  // ---- Topology ----
  const org = await api('POST', '/api/orgs', alice, { name: 'Acme Mobile' });
  await api('POST', `/api/orgs/${org.id}/members`, alice, { email: BOB, role: 'MEMBER' });
  const project = await api('POST', `/api/orgs/${org.id}/projects`, alice, { key: 'storefront-app', name: 'Storefront App' });
  const envs = Object.fromEntries(project.environments.map((e) => [e.key, e]));
  const beta = await api('POST', '/api/orgs', carol, { name: 'Beta Labs' });
  const betaProject = await api('POST', `/api/orgs/${beta.id}/projects`, carol, { key: 'labs-app', name: 'Labs App' });
  await api('POST', `/api/projects/${betaProject.id}/flags`, carol, { key: 'labs-experiment', name: 'Labs Experiment', kind: 'BOOLEAN' });

  const sdkKeys = {};
  for (const key of ['dev', 'staging', 'production']) {
    const created = await api('POST', `/api/environments/${envs[key].id}/sdk-keys`, alice, { label: `${key} server key` });
    sdkKeys[key] = created.key;
  }
  console.log('Topology ready: Acme Mobile / storefront-app + Beta Labs / labs-app');

  const P = project.id;
  const flagPath = (key) => `/api/projects/${P}/flags/${key}`;
  const putEnv = (key, envKey, body) => api('PUT', `${flagPath(key)}/environments/${envKey}`, alice, body);
  const config = (over) => ({
    individualTargets: [], rules: [], ...over,
  });

  // ---- Segment ----
  await api('POST', `/api/projects/${P}/segments`, alice, {
    key: 'beta-testers', name: 'Beta testers',
    includedKeys: ['user-alice', 'user-101', 'user-102'],
    rules: [{ clauses: [{ attribute: 'betaOptIn', op: 'EQUALS', values: ['true'] }] }],
  });

  // ---- Flags ----
  // 1. new-checkout: BOOLEAN, ramping with real history (10 -> rollback -> 25)
  const checkout = await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'new-checkout', name: 'New checkout flow', kind: 'BOOLEAN',
    description: 'Rebuilt one-page checkout', tags: ['checkout', 'revenue'],
  });
  const ct = varByValue(checkout, 'true');
  const cf = varByValue(checkout, 'false');
  const checkoutRamp = (pct, expectedVersion, comment) => putEnv('new-checkout', 'production', {
    enabled: true, expectedVersion, comment,
    config: config({
      fallthrough: { rollout: [{ variationId: ct, weight: pct }, { variationId: cf, weight: 100 - pct }] },
      offVariationId: cf, defaultVariationId: ct,
    }),
  });
  await checkoutRamp(10, 1, 'initial ramp 10%');
  await api('POST', `${flagPath('new-checkout')}/environments/production/rollback`, alice, { toVersion: 1, reason: 'checkout error spike, backing out' });
  await checkoutRamp(25, 3, 'retry ramp at 25% after fix');
  await putEnv('new-checkout', 'staging', {
    enabled: true, expectedVersion: 1, comment: 'staging 50%',
    config: config({ fallthrough: { rollout: [{ variationId: ct, weight: 50 }, { variationId: cf, weight: 50 }] }, offVariationId: cf, defaultVariationId: ct }),
  });
  await putEnv('new-checkout', 'dev', {
    enabled: true, expectedVersion: 1, comment: 'fully on in dev',
    config: config({ fallthrough: { variationId: ct }, offVariationId: cf, defaultVariationId: ct }),
  });

  // 2. planner-v2: multivariate 60/20/20
  const planner = await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'planner-v2', name: 'Planner layout v2', kind: 'STRING', tags: ['experiment'],
    variations: [
      { value: 'control', name: 'Control' },
      { value: 'compact', name: 'Compact' },
      { value: 'expanded', name: 'Expanded' },
    ],
  });
  await putEnv('planner-v2', 'production', {
    enabled: true, expectedVersion: 1, comment: 'three-way experiment 60/20/20',
    config: config({
      fallthrough: { rollout: [
        { variationId: varByValue(planner, 'control'), weight: 60 },
        { variationId: varByValue(planner, 'compact'), weight: 20 },
        { variationId: varByValue(planner, 'expanded'), weight: 20 },
      ] },
      offVariationId: varByValue(planner, 'control'), defaultVariationId: varByValue(planner, 'control'),
    }),
  });

  // 3. pro-plan-features: segment + plan rule
  const pro = await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'pro-plan-features', name: 'Pro plan features', kind: 'BOOLEAN', tags: ['plans'],
  });
  await putEnv('pro-plan-features', 'production', {
    enabled: true, expectedVersion: 1, comment: 'beta testers + pro plan only',
    config: config({
      rules: [
        { id: ruleId(), clauses: [{ attribute: 'key', op: 'SEGMENT_MATCH', values: ['beta-testers'] }], serve: { variationId: varByValue(pro, 'true') } },
        { id: ruleId(), clauses: [{ attribute: 'plan', op: 'EQUALS', values: ['pro'] }], serve: { variationId: varByValue(pro, 'true') } },
      ],
      fallthrough: { variationId: varByValue(pro, 'false') },
      offVariationId: varByValue(pro, 'false'), defaultVariationId: varByValue(pro, 'true'),
    }),
  });

  // 4. payment-provider-v2: killed in production (with a reason), error-heavy metrics below
  const pay = await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'payment-provider-v2', name: 'Payment provider v2', kind: 'BOOLEAN', tags: ['payments', 'revenue'],
  });
  await putEnv('payment-provider-v2', 'production', {
    enabled: true, expectedVersion: 1, comment: 'ramp 50%',
    config: config({
      fallthrough: { rollout: [{ variationId: varByValue(pay, 'true'), weight: 50 }, { variationId: varByValue(pay, 'false'), weight: 50 }] },
      offVariationId: varByValue(pay, 'false'), defaultVariationId: varByValue(pay, 'true'),
    }),
  });
  await api('POST', `${flagPath('payment-provider-v2')}/environments/production/kill-switch`, alice, {
    active: true, reason: 'declines spiking on provider v2 - killed pending vendor fix',
  });

  // 5. dark-mode: stale 100% on (backdated below)
  const dark = await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'dark-mode', name: 'Dark mode', kind: 'BOOLEAN', tags: ['ui'],
  });
  for (const [envKey, v] of [['production', 1], ['staging', 1], ['dev', 1]]) {
    await putEnv('dark-mode', envKey, {
      enabled: true, expectedVersion: v, comment: 'fully on',
      config: config({ fallthrough: { variationId: varByValue(dark, 'true') }, offVariationId: varByValue(dark, 'false'), defaultVariationId: varByValue(dark, 'true') }),
    });
  }

  // 6. ios-push-refresh: platform rule with per-rule 10% rollout
  const push = await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'ios-push-refresh', name: 'iOS push refresh', kind: 'BOOLEAN', tags: ['mobile'],
  });
  await putEnv('ios-push-refresh', 'production', {
    enabled: true, expectedVersion: 1, comment: 'iOS only, 10% inside the rule',
    config: config({
      rules: [{
        id: ruleId(),
        clauses: [{ attribute: 'platform', op: 'EQUALS', values: ['ios'] }],
        serve: { rollout: [{ variationId: varByValue(push, 'true'), weight: 10 }, { variationId: varByValue(push, 'false'), weight: 90 }] },
      }],
      fallthrough: { variationId: varByValue(push, 'false') },
      offVariationId: varByValue(push, 'false'), defaultVariationId: varByValue(push, 'true'),
    }),
  });

  // 7. debug-logging: individual target for alice only
  const dbg = await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'debug-logging', name: 'Debug logging', kind: 'BOOLEAN', tags: ['internal'],
  });
  await putEnv('debug-logging', 'production', {
    enabled: true, expectedVersion: 1, comment: 'alice only',
    config: config({
      individualTargets: [{ contextKey: 'user-alice', variationId: varByValue(dbg, 'true') }],
      fallthrough: { variationId: varByValue(dbg, 'false') },
      offVariationId: varByValue(dbg, 'false'), defaultVariationId: varByValue(dbg, 'false'),
    }),
  });

  // 8. legacy-search: 0% stale (retirement fodder; backdated below)
  await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'legacy-search', name: 'Legacy search', kind: 'BOOLEAN', tags: ['cleanup'],
  });

  // 9. agent-planner-prompt: AGENT-GATING demo - feature-gate part of an AI agent to A/B test it.
  //    Agent runs evaluate with context {key: <run-id>, attributes: {agent, version, plan}} and the
  //    flag decides which prompt variant that run uses; the rollout monitor then compares variants.
  const agentFlag = await api('POST', `/api/projects/${P}/flags`, alice, {
    key: 'agent-planner-prompt', name: 'Meal-planner agent prompt', kind: 'STRING',
    description: 'Which system-prompt revision the meal-planner agent runs with',
    tags: ['agents', 'experiment'],
    variations: [
      { value: 'prompt-v1', name: 'Prompt v1 (baseline)' },
      { value: 'prompt-v2', name: 'Prompt v2 (structured outputs)' },
    ],
  });
  await putEnv('agent-planner-prompt', 'production', {
    enabled: true, expectedVersion: 1, comment: '50/50 prompt experiment for the meal-planner agent',
    config: config({
      rules: [{
        id: ruleId(),
        clauses: [{ attribute: 'agent', op: 'EQUALS', values: ['meal-planner'] }],
        serve: { rollout: [
          { variationId: varByValue(agentFlag, 'prompt-v1'), weight: 50 },
          { variationId: varByValue(agentFlag, 'prompt-v2'), weight: 50 },
        ] },
      }],
      fallthrough: { variationId: varByValue(agentFlag, 'prompt-v1') },
      offVariationId: varByValue(agentFlag, 'prompt-v1'),
      defaultVariationId: varByValue(agentFlag, 'prompt-v1'),
    }),
  });
  console.log('9 flags seeded (incl. agent-gating demo agent-planner-prompt)');

  // ---- Events: ~48h of traffic; payment-provider-v2 treatment error-heavy ----
  const prodDetail = {};
  for (const key of ['new-checkout', 'payment-provider-v2', 'planner-v2', 'agent-planner-prompt']) {
    prodDetail[key] = await api('GET', flagPath(key), alice);
  }
  const evalBatch = [];
  const metricBatch = [];
  const pushEval = (flagKey, contextKey, variationId, h) =>
    evalBatch.push({ flagKey, contextKey, variationId, reason: 'ROLLOUT', occurredAt: hoursAgo(h) });
  const pushMetric = (contextKey, metricKey, value, h) =>
    metricBatch.push({ contextKey, metricKey, value, occurredAt: hoursAgo(h) });

  for (let i = 0; i < 300; i++) {
    const user = `user-${i}`;
    const h = (i % 47) + Math.random();
    // new-checkout: ~25% treatment, treatment converts BETTER (optimization fodder)
    const inCheckout = i % 4 === 0;
    pushEval('new-checkout', user, inCheckout ? ct : cf, h);
    if (Math.random() < (inCheckout ? 0.3 : 0.18)) pushMetric(user, 'conversion', 1, h);
    // payment-provider-v2: 50/50, treatment error-heavy (healing fodder)
    const payDetailVars = prodDetail['payment-provider-v2'].variations;
    const inPay = i % 2 === 0;
    pushEval('payment-provider-v2', user, inPay ? payDetailVars.find(v => v.value === 'true').id : payDetailVars.find(v => v.value === 'false').id, h);
    if (Math.random() < (inPay ? 0.2 : 0.02)) pushMetric(user, 'error', 1, h);
    // planner-v2 spread
    const pv = prodDetail['planner-v2'].variations;
    pushEval('planner-v2', user, pv[i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : 2].id, h);
  }
  // agent runs: run-ids as context keys, agent attribute traffic
  const av = prodDetail['agent-planner-prompt'].variations;
  for (let i = 0; i < 200; i++) {
    const run = `agent-run-${i}`;
    const h = (i % 47) + Math.random();
    const v2 = i % 2 === 0;
    pushEval('agent-planner-prompt', run, av[v2 ? 1 : 0].id, h);
    if (Math.random() < (v2 ? 0.42 : 0.3)) pushMetric(run, 'conversion', 1, h); // v2 completes plans more often
    if (Math.random() < (v2 ? 0.03 : 0.04)) pushMetric(run, 'error', 1, h);
  }
  for (let i = 0; i < evalBatch.length; i += 400) {
    await api('POST', '/api/events/eval', sdkKeys.production, { events: evalBatch.slice(i, i + 400) });
  }
  for (let i = 0; i < metricBatch.length; i += 400) {
    await api('POST', '/api/events/metrics', sdkKeys.production, { events: metricBatch.slice(i, i + 400) });
  }
  console.log(`${evalBatch.length} eval events + ${metricBatch.length} metric events ingested`);

  // ---- Backdate the stale flags (deliberate psql step: staleness cannot be seeded via API) ----
  psql(`UPDATE flag_env_configs SET updated_at = now() - interval '6 weeks' WHERE flag_id IN (SELECT id FROM flags WHERE key IN ('dark-mode','legacy-search'))`);
  psql(`UPDATE flag_env_config_versions SET created_at = now() - interval '6 weeks' WHERE flag_id IN (SELECT id FROM flags WHERE key IN ('dark-mode','legacy-search'))`);
  console.log('dark-mode + legacy-search backdated 6 weeks (stale-flag fodder)');

  // ---- Run the monitor jobs so the app opens onto live findings ----
  for (const job of ['rollout-scan', 'stale-flag-scan']) {
    try {
      const res = await fetch(`${API}/api/jobs/${job}`, { method: 'POST', headers: { 'X-Job-Token': JOB_TOKEN } });
      console.log(`job ${job}: ${res.status} ${(await res.text()).slice(0, 120)}`);
    } catch (e) {
      console.log(`job ${job} skipped: ${e.message}`);
    }
  }

  console.log('\nSeed complete. App logins (password123): alice@switchboard.dev (owner), bob@switchboard.dev (member), carol@beta.dev (Beta Labs owner)');
  console.log('SDK keys (store these; shown only once):');
  for (const [env, key] of Object.entries(sdkKeys)) console.log(`  ${env}: ${key}`);
}

main().catch((e) => { console.error('\nSeed failed:', e.message); process.exit(1); });
