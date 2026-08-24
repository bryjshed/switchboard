#!/usr/bin/env node
/**
 * Live proof that this SDK agrees with the Switchboard backend.
 *
 * The conformance vectors prove the evaluator matches the spec on paper. This proves the whole SDK
 * matches the running server: it mints a real SDK key, boots a real client, and for every seeded
 * flag and a spread of contexts asserts that the answer computed locally in memory is byte-for-byte
 * the answer `POST /api/eval/{flagKey}` gives for the same context. Value, variation, reason and
 * rule all have to match. Any disagreement is a hard failure, because a local evaluation that
 * silently diverges from the server is worse than no SDK at all.
 *
 * It then flips a flag through the management API and waits for the SSE stream to deliver it,
 * flushes telemetry, and points a client at a dead port to show the degradation path.
 *
 *   node scripts/live-check.mjs
 *
 * Env: SWITCHBOARD_URL (default http://localhost:28080), SWITCHBOARD_DEV_TOKEN
 *      (default dev:alice@switchboard.dev), SWITCHBOARD_PROJECT (default storefront-app),
 *      SWITCHBOARD_ENV (default production).
 */
import { SwitchboardClient } from '../dist/esm/core.js';

const BASE_URL = (process.env.SWITCHBOARD_URL ?? 'http://localhost:28080').replace(/\/+$/, '');
const DEV_TOKEN = process.env.SWITCHBOARD_DEV_TOKEN ?? 'dev:alice@switchboard.dev';
const PROJECT_KEY = process.env.SWITCHBOARD_PROJECT ?? 'storefront-app';
const ENV_KEY = process.env.SWITCHBOARD_ENV ?? 'production';

let passed = 0;
let failed = 0;

function pass(message) {
  passed += 1;
  console.log(`PASS  ${message}`);
}

function fail(message, detail) {
  failed += 1;
  console.log(`FAIL  ${message}${detail === undefined ? '' : `\n        ${detail}`}`);
}

function check(condition, message, detail) {
  if (condition) {
    pass(message);
  } else {
    fail(message, detail);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

async function api(path, { method = 'GET', body, token = DEV_TOKEN, headers = {} } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  return { status: response.status, json: text === '' ? null : JSON.parse(text) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return Date.now() - (deadline - timeoutMs);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(25);
  }
}

// ---------------------------------------------------------------------------------------------
// The contexts the agreement matrix is run over. Each one exercises a different targeting path.
// ---------------------------------------------------------------------------------------------
const CONTEXTS = [
  { label: 'individually targeted user', context: { key: 'user-alice' } },
  { label: 'segment member by key', context: { key: 'user-101' } },
  { label: 'segment member by attribute', context: { key: 'user-777', attributes: { betaOptIn: 'true' } } },
  { label: 'pro plan', context: { key: 'user-2001', attributes: { plan: 'pro' } } },
  { label: 'free plan on ios', context: { key: 'user-2002', attributes: { plan: 'free', platform: 'ios' } } },
  { label: 'free plan on android', context: { key: 'user-2003', attributes: { plan: 'free', platform: 'android' } } },
  { label: 'anonymous', context: { key: 'anon-90210' } },
  { label: 'agent run, meal-planner', context: { key: 'run-8f21c4', attributes: { agent: 'meal-planner' } } },
  { label: 'agent run, shopping-list', context: { key: 'run-8f21c4', attributes: { agent: 'shopping-list' } } },
  { label: 'agent run, second run id', context: { key: 'run-01bd77', attributes: { agent: 'meal-planner' } } },
];

const FLAGS = [
  ['new-checkout', 'percentage rollout'],
  ['planner-v2', 'multivariate 60/20/20'],
  ['pro-plan-features', 'segment + attribute rules'],
  ['payment-provider-v2', 'kill switch active'],
  ['dark-mode', 'plain on'],
  ['ios-push-refresh', 'rule with an inner rollout'],
  ['debug-logging', 'individual target'],
  ['agent-planner-prompt', 'agent-scoped split'],
  ['legacy-search', 'flag off'],
  ['no-such-flag-anywhere', 'unknown flag'],
];

let client = null;
let createdKeyId = null;
let killSwitchFlipped = false;
let projectId = null;

async function main() {
  console.log(`Switchboard live check against ${BASE_URL} (${PROJECT_KEY}/${ENV_KEY})`);

  // -------------------------------------------------------------------------------------------
  section('setup');
  const orgs = (await api('/api/orgs')).json;
  const org = orgs[0];
  if (org === undefined) {
    throw new Error('no orgs visible to the dev token; is the backend seeded?');
  }
  const projects = (await api(`/api/orgs/${org.id}/projects`)).json;
  const project = projects.find((entry) => entry.key === PROJECT_KEY) ?? projects[0];
  projectId = project.id;
  const environment = project.environments.find((entry) => entry.key === ENV_KEY);
  if (environment === undefined) {
    throw new Error(`environment ${ENV_KEY} not found in project ${project.key}`);
  }
  const created = (
    await api(`/api/environments/${environment.id}/sdk-keys`, {
      method: 'POST',
      body: { label: `live-check ${new Date().toISOString()}` },
    })
  ).json;
  createdKeyId = created.id;
  const sdkKey = created.key;
  pass(`minted SDK key ${created.keyPrefix}... for ${project.key}/${environment.key}`);

  // -------------------------------------------------------------------------------------------
  section('client startup');
  client = new SwitchboardClient({
    sdkKey,
    baseUrl: BASE_URL,
    mode: 'streaming',
    telemetry: { flushIntervalMs: 0 },
    logger: { error: console.error, warn: console.warn, info: () => {}, debug: () => {} },
  });
  const startedAt = Date.now();
  await client.start();
  check(client.status === 'READY', `client reached READY in ${Date.now() - startedAt}ms`, `status was ${client.status}`);
  check(
    client.stateVersion === environment.stateVersion,
    `local stateVersion ${client.stateVersion} matches the environment`,
    `environment says ${environment.stateVersion}`,
  );
  const flagCount = Object.keys(client.allFlags({ key: 'probe' })).length;
  check(flagCount > 0, `bootstrap carried ${flagCount} flags`);

  // -------------------------------------------------------------------------------------------
  section('client vs server agreement');
  let comparisons = 0;
  let disagreements = 0;
  for (const [flagKey, note] of FLAGS) {
    const rows = [];
    for (const { label, context } of CONTEXTS) {
      const local = client.stringDetail(flagKey, context, 'SDK-DEFAULT-SENTINEL');
      const server = await client.serverEvaluate(flagKey, context, 'SDK-DEFAULT-SENTINEL');
      comparisons += 1;
      const agrees =
        local.value === server.value &&
        (local.variationId ?? null) === (server.variationId ?? null) &&
        local.reason === server.reason &&
        (local.ruleId ?? null) === (server.ruleId ?? null);
      if (!agrees) {
        disagreements += 1;
        fail(
          `${flagKey} / ${label} disagrees`,
          `local  = ${JSON.stringify({ value: local.value, variationId: local.variationId, reason: local.reason, ruleId: local.ruleId })}\n        server = ${JSON.stringify({ value: server.value, variationId: server.variationId ?? null, reason: server.reason, ruleId: server.ruleId ?? null })}`,
        );
      }
      rows.push(`${label} -> ${local.value} (${local.reason})`);
    }
    if (rows.length > 0 && disagreements === 0) {
      pass(`${flagKey} (${note}): ${CONTEXTS.length}/${CONTEXTS.length} contexts agree with the server`);
      for (const row of rows) {
        console.log(`        ${row}`);
      }
    }
  }
  check(
    disagreements === 0,
    `${comparisons} client/server comparisons, ${disagreements} disagreements`,
    'local evaluation diverged from the server',
  );

  // The unknown flag is a contract of its own: the caller's default, never an error.
  const unknown = client.stringDetail('no-such-flag-anywhere', { key: 'user-alice' }, 'caller-default');
  check(
    unknown.value === 'caller-default' && unknown.reason === 'SDK_DEFAULT' && unknown.errorKind === 'FLAG_NOT_FOUND',
    'unknown flag serves the caller default with reason SDK_DEFAULT',
    JSON.stringify(unknown),
  );

  // Bucketing is a pure function of flagKey + contextKey, so the same run id is reproducible.
  const first = client.stringValue('agent-planner-prompt', { key: 'run-8f21c4', attributes: { agent: 'meal-planner' } }, 'x');
  const again = client.stringValue('agent-planner-prompt', { key: 'run-8f21c4', attributes: { agent: 'meal-planner' } }, 'x');
  check(first === again, `agent-planner-prompt is reproducible for the same run id (${first})`);

  // -------------------------------------------------------------------------------------------
  section('streaming a live change');
  const target = 'dark-mode';
  const before = client.booleanValue(target, { key: 'user-alice' }, false);
  check(before === true, `${target} starts on`);

  const changes = [];
  client.on('change', (event) => changes.push(event));
  const versionBefore = client.stateVersion;

  const flippedAt = Date.now();
  await api(`/api/projects/${projectId}/flags/${target}/environments/${ENV_KEY}/kill-switch`, {
    method: 'POST',
    body: { active: true, reason: 'sdk live-check' },
  });
  killSwitchFlipped = true;

  try {
    await waitUntil(() => client.stateVersion > versionBefore, 8_000, 'the SSE stream to deliver the flip');
    const elapsed = Date.now() - flippedAt;
    const detail = client.booleanDetail(target, { key: 'user-alice' }, true);
    check(
      detail.value === false && detail.reason === 'KILL_SWITCH',
      `SSE delivered the kill switch in ${elapsed}ms and local evaluation now says false (${detail.reason})`,
      JSON.stringify(detail),
    );
    check(
      changes.some((event) => event.flagKeys.includes(target)),
      `a change event named "${target}"`,
      JSON.stringify(changes),
    );
    // And the server agrees with the new local answer.
    const server = await client.serverEvaluate(target, { key: 'user-alice' }, 'x');
    check(
      server.value === 'false' && server.reason === detail.reason,
      'server agrees with the post-change local evaluation',
      `server = ${JSON.stringify(server)}`,
    );
  } finally {
    const restoredVersion = client.stateVersion;
    await api(`/api/projects/${projectId}/flags/${target}/environments/${ENV_KEY}/kill-switch`, {
      method: 'POST',
      body: { active: false, reason: 'sdk live-check restore' },
    });
    killSwitchFlipped = false;
    await waitUntil(() => client.stateVersion > restoredVersion, 8_000, 'the restore to stream back').catch(
      () => undefined,
    );
    check(client.booleanValue(target, { key: 'user-alice' }, false) === true, `${target} restored to on`);
  }

  // -------------------------------------------------------------------------------------------
  section('telemetry');
  for (const { context } of CONTEXTS) {
    client.booleanValue('new-checkout', context, false);
  }
  client.track('live-check.completed', 'user-alice');
  client.track('live-check.latency-ms', 'user-alice', 42);
  const queued = client.telemetryStats.queuedEvalEvents;
  check(queued > 0, `${queued} evaluation events buffered rather than posted one by one`);

  await client.flush();
  const stats = client.telemetryStats;
  check(
    stats.failedFlushes === 0 && stats.sent >= queued + 2 && stats.queuedEvalEvents === 0,
    `flush accepted: ${stats.sent} events sent, ${stats.failedFlushes} failed flushes`,
    JSON.stringify(stats),
  );

  // The 202 itself, straight from the endpoint, so the status code is proven and not inferred.
  const accepted = await fetch(`${BASE_URL}/api/events/metrics`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sdkKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [{ contextKey: 'user-alice', metricKey: 'live-check.probe', value: 1, occurredAt: new Date().toISOString() }],
    }),
  });
  check(accepted.status === 202, `POST /api/events/metrics returned ${accepted.status}`);

  // -------------------------------------------------------------------------------------------
  section('openfeature provider');
  // The provider is a wrapper over the same client, so this proves the documented OpenFeature path
  // reaches the same answers. Skipped rather than failed when the optional peer dep is absent.
  let openFeature = null;
  try {
    openFeature = await import('@openfeature/server-sdk');
  } catch {
    console.log('SKIP  @openfeature/server-sdk is not installed');
  }
  if (openFeature !== null) {
    const { SwitchboardProvider } = await import('../dist/esm/index.js');
    const provider = new SwitchboardProvider({ sdkKey, baseUrl: BASE_URL, telemetry: false });
    await openFeature.OpenFeature.setProviderAndWait(provider);
    const ofClient = openFeature.OpenFeature.getClient();
    check(provider.status === 'READY', 'provider reached READY');
    let mismatches = 0;
    for (const { context } of CONTEXTS) {
      const attributes = context.attributes ?? {};
      const detail = await ofClient.getStringDetails('agent-planner-prompt', 'prompt-v1', {
        targetingKey: context.key,
        ...attributes,
      });
      const direct = client.stringValue('agent-planner-prompt', context, 'prompt-v1');
      if (detail.value !== direct) {
        mismatches += 1;
      }
    }
    check(mismatches === 0, `provider and core client agree across ${CONTEXTS.length} contexts`);
    const unknownDetail = await ofClient.getStringDetails('no-such-flag-anywhere', 'caller-default', {
      targetingKey: 'user-alice',
    });
    check(
      unknownDetail.value === 'caller-default' &&
        unknownDetail.errorCode === 'FLAG_NOT_FOUND' &&
        unknownDetail.flagMetadata.switchboardReason === 'SDK_DEFAULT',
      'provider reports an unknown flag as FLAG_NOT_FOUND with the Switchboard reason intact',
      JSON.stringify(unknownDetail),
    );
    await openFeature.OpenFeature.close();
  }

  // -------------------------------------------------------------------------------------------
  section('backend unreachable');
  const snapshot = await (
    await fetch(`${BASE_URL}/api/eval/bootstrap`, { headers: { Authorization: `Bearer ${sdkKey}` } })
  ).json();
  const deadClient = new SwitchboardClient({
    sdkKey,
    baseUrl: 'http://127.0.0.1:1',
    bootstrapTimeoutMs: 1_000,
    telemetry: false,
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  });
  let threw = null;
  try {
    await deadClient.start();
    deadClient.booleanValue('dark-mode', { key: 'user-alice' }, false);
  } catch (error) {
    threw = error;
  }
  check(threw === null, 'a client pointed at a dead port starts without throwing', String(threw));
  check(
    deadClient.booleanValue('dark-mode', { key: 'user-alice' }, true) === true &&
      deadClient.stringValue('planner-v2', { key: 'user-alice' }, 'fallback') === 'fallback',
    'with no config at all it serves the caller default',
  );
  check(
    deadClient.stringDetail('dark-mode', { key: 'user-alice' }, 'x').errorKind === 'CLIENT_NOT_READY',
    'and says why: errorKind CLIENT_NOT_READY, reason SDK_DEFAULT',
  );
  await deadClient.close();

  // Same dead port, but seeded from a snapshot: degrade to last-known config, not to defaults.
  const seeded = new SwitchboardClient({
    sdkKey,
    baseUrl: 'http://127.0.0.1:1',
    bootstrapTimeoutMs: 1_000,
    telemetry: false,
    initialBootstrap: snapshot,
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  });
  await seeded.start();
  const seededDetail = seeded.booleanDetail('dark-mode', { key: 'user-alice' }, false);
  check(
    seededDetail.value === true && seededDetail.reason === 'DEFAULT',
    'seeded from a snapshot, a dead backend still serves real config',
    JSON.stringify(seededDetail),
  );
  await seeded.close();
}

async function cleanup() {
  try {
    if (killSwitchFlipped && projectId !== null) {
      await api(`/api/projects/${projectId}/flags/dark-mode/environments/${ENV_KEY}/kill-switch`, {
        method: 'POST',
        body: { active: false, reason: 'sdk live-check cleanup' },
      });
    }
  } catch (error) {
    console.log(`      (could not restore the kill switch: ${String(error)})`);
  }
  try {
    await client?.close();
  } catch {
    // Closing a client is best-effort here.
  }
  try {
    if (createdKeyId !== null) {
      await api(`/api/sdk-keys/${createdKeyId}`, { method: 'DELETE' });
    }
  } catch (error) {
    console.log(`      (could not revoke the live-check SDK key: ${String(error)})`);
  }
}

main()
  .catch((error) => {
    fail('live check aborted', error?.stack ?? String(error));
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
