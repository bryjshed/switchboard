#!/usr/bin/env node
// Switchboard load and latency harness. Plain Node, no deps.
//
// WHY THIS IS SHAPED THE WAY IT IS
//
// The point of this script is to produce percentiles that are honest enough to publish.
// Three things decide whether a latency number means anything, and all three are easy to
// get wrong in a way that flatters the result:
//
//  1. COORDINATED OMISSION. A closed-loop generator (N workers looping request -> response
//     -> request) stops sending while the server is stalled, so the stall never appears in
//     the sample. It measures service time, not what a client experiences. The default mode
//     here is OPEN loop: requests are scheduled at a fixed arrival rate and latency is
//     measured from the time the request was DUE, not the time it was sent. The difference
//     between the two is reported as `queueDelay` so the size of the effect is visible
//     rather than assumed away.
//
//  2. THE GENERATOR BEING THE BOTTLENECK. Node is single-threaded; at a high enough rate
//     the numbers describe this script rather than the server. Event-loop delay is sampled
//     throughout and reported. If p99 loop lag is a meaningful fraction of p99 latency, the
//     run is not trustworthy and the script says so out loud.
//
//  3. JIT WARMUP. The JVM needs thousands of iterations before C2 compiles the hot path.
//     A warmup phase runs first and is discarded. Note that `mvnw spring-boot:run` passes
//     -XX:TieredStopAtLevel=1, which caps the JIT at C1 and makes the server permanently
//     slower than a real deployment -- measure against `java -jar`, not `make backend`.
//     See docs/PERFORMANCE.md.
//
// Percentiles are computed from the full retained sample by nearest-rank, not from a
// histogram approximation, because the sample sizes here fit in memory comfortably.
//
// Usage:
//   node scripts/load-test.mjs                       # every scenario at default rate
//   node scripts/load-test.mjs --rate 400 --duration 30
//   node scripts/load-test.mjs --scenario eval-single --mode closed --concurrency 64
//   node scripts/load-test.mjs --json /tmp/load.json # machine-readable output
//
// Exit 0 = ran clean; 1 = setup failed or a scenario produced errors.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const uuid = randomUUID;

// ----------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(`--${name}`);

const BASE = arg('base', process.env.API_BASE_URL ?? 'http://localhost:28080');
const MGMT = arg('mgmt', process.env.MGMT_BASE_URL ?? BASE.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`));
const RATE = Number(arg('rate', 200));
const DURATION = Number(arg('duration', 20));
const WARMUP = Number(arg('warmup', 10));
const MODE = arg('mode', 'open');
const CONCURRENCY = Number(arg('concurrency', 50));
const SOCKETS = Number(arg('sockets', 128));
const FLAG_COUNT = Number(arg('flags', 50));
// One Node process is single-threaded and becomes the bottleneck well before the server
// does -- the first honest run of this script saturated its own event loop at ~28k/s while
// reporting 40% loop lag. Load is therefore split across forked generator processes and
// their samples merged. Default is half the cores, leaving the rest for the server under
// test when (as here) both are on one machine.
const WORKERS = Number(arg('workers', Math.max(1, Math.floor(availableParallelism() / 2))));
const ONLY = arg('scenario', null);
const JSON_OUT = arg('json', null);
const QUIET = has('quiet');

const url = new URL(BASE);
const agent = new http.Agent({
  keepAlive: true,
  maxSockets: SOCKETS,
  maxFreeSockets: SOCKETS,
  // A load generator must not silently queue on socket exhaustion; that is coordinated
  // omission by another name. The cap is high and saturation is reported instead.
  scheduling: 'fifo',
});

// ------------------------------------------------------------------ requests

/**
 * One HTTP request. Resolves with status and elapsed timings; never rejects, because a
 * connection error during a saturation run is data, not a crash.
 */
function request(method, path, { token, body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const sentAt = performance.now();
    const req = http.request(
      {
        agent,
        host: url.hostname,
        port: url.port,
        method,
        path,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        // The body must be fully drained: a response is not "received" until its last byte
        // lands, and leaving it unread would both understate latency and leak the socket.
        let size = 0;
        const chunks = [];
        res.on('data', (c) => { size += c.length; chunks.push(c); });
        res.on('end', () => resolve({
          status: res.statusCode,
          sentAt,
          doneAt: performance.now(),
          size,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, sentAt, doneAt: performance.now(), size: 0, error: e.message, headers: {}, text: '' }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Convenience wrapper used by setup, where a non-2xx is a hard failure. */
async function api(method, path, opts = {}) {
  const r = await request(method, path, opts);
  let json = null;
  try { json = r.text ? JSON.parse(r.text) : null; } catch { /* non-JSON */ }
  return { ...r, json };
}

// ------------------------------------------------------------------ statistics

/** Nearest-rank percentile over an already-sorted Float64Array. */
function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function summarize(values) {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : NaN;
  return {
    n,
    mean,
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    p999: pct(sorted, 99.9),
    max: n ? sorted[n - 1] : NaN,
  };
}

const ms = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');

// ------------------------------------------------------------------ scenarios

/**
 * Each scenario names a hot path and knows how to build one request. `weightNote` is the
 * honest caveat that belongs next to its number in the write-up.
 */
function buildScenarios(fx) {
  const ctx = (i) => ({ key: `load-user-${i % 100000}`, attributes: { plan: i % 3 === 0 ? 'pro' : 'free', country: i % 2 ? 'US' : 'GB', appVersion: '4.3.1' } });

  return [
    {
      name: 'eval-single',
      title: 'POST /api/eval/{key} — single remote evaluation',
      note: 'The OFREP/remote-eval hot path. One flag, one context.',
      build: (i) => ['POST', `/api/eval/${fx.hotFlagKey}`, { token: fx.serverKey, body: { context: ctx(i), default: false } }],
      ok: (r) => r.status === 200,
    },
    {
      name: 'eval-bulk',
      title: 'POST /api/eval — bulk evaluation (all flags, one context)',
      note: `Every flag in the environment (${fx.flagCount}) evaluated for one context.`,
      build: (i) => ['POST', '/api/eval', { token: fx.serverKey, body: { context: ctx(i) } }],
      ok: (r) => r.status === 200,
    },
    {
      name: 'bootstrap-full',
      title: 'GET /api/eval/bootstrap — full rule-set payload (server key)',
      note: 'What a local-evaluation SDK fetches on start-up. Served from EnvSnapshotCache.',
      build: () => ['GET', '/api/eval/bootstrap', { token: fx.serverKey }],
      ok: (r) => r.status === 200,
    },
    {
      name: 'bootstrap-304',
      title: 'GET /api/eval/bootstrap — conditional, ETag hit',
      note: 'The steady-state SDK poll. Should be dominated by connection handling, not work.',
      build: () => ['GET', '/api/eval/bootstrap', { token: fx.serverKey, headers: { 'If-None-Match': fx.etag } }],
      ok: (r) => r.status === 304,
    },
    {
      name: 'bootstrap-client',
      title: 'POST /api/eval/bootstrap — evaluated payload (client key)',
      note: 'Per-context, so it cannot be shared-cached; the ETag digests the body.',
      build: (i) => ['POST', '/api/eval/bootstrap', { token: fx.clientKey, body: { context: ctx(i) } }],
      ok: (r) => r.status === 200,
    },
    {
      name: 'ofrep-bulk',
      title: 'POST /ofrep/v1/evaluate/flags — OFREP bulk',
      note: 'The vendor-neutral path six OpenFeature providers use.',
      // OFREP's context is flat: targetingKey plus scalar properties, not the native
      // { key, attributes } shape.
      build: (i) => ['POST', '/ofrep/v1/evaluate/flags', {
        token: fx.serverKey,
        body: { context: { targetingKey: `load-user-${i % 100000}`, plan: i % 3 === 0 ? 'pro' : 'free', country: i % 2 ? 'US' : 'GB', appVersion: '4.3.1' } },
      }],
      ok: (r) => r.status === 200,
    },
    {
      name: 'events-ingest',
      title: 'POST /api/events/eval — telemetry ingest (202)',
      note: 'Batched writes into the partitioned event tables. Accepted, not durable-acked.',
      build: (i) => ['POST', '/api/events/eval', {
        token: fx.serverKey,
        body: {
          events: Array.from({ length: 20 }, (_, j) => ({
            flagKey: fx.hotFlagKey,
            contextKey: `load-user-${(i * 20 + j) % 100000}`,
            reason: 'ROLLOUT',
            occurredAt: new Date().toISOString(),
          })),
        },
      }],
      ok: (r) => r.status === 202,
    },
    {
      name: 'flags-list',
      title: 'GET /api/projects/{id}/flags — dashboard list (user token)',
      note: 'Human-paced, but it is the page every session opens on. Uncached today.',
      build: () => ['GET', `/api/projects/${fx.projectId}/flags?limit=50`, { token: fx.userToken }],
      ok: (r) => r.status === 200,
    },
  ];
}

// ------------------------------------------------------------------ the runner

/**
 * Open-loop: dispatch on a fixed schedule regardless of whether earlier requests have come
 * back, and measure from the moment each request was DUE. This is the mode whose numbers
 * are safe to quote.
 */
async function runOpen(scenario, rate, seconds, collect, transport = request) {
  const started = performance.now();
  const endAt = started + seconds * 1000;
  const interval = 1000 / rate;
  let issued = 0;
  let peakInFlight = 0;
  let inFlight = 0;
  const pending = [];

  return new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      if (now >= endAt) {
        clearInterval(timer);
        Promise.allSettled(pending).then(() => resolve({ issued, peakInFlight }));
        return;
      }
      // Dispatch everything whose scheduled time has arrived. Falling behind here is what
      // queueDelay is measuring, so we do not skip or coalesce.
      while (started + issued * interval <= now) {
        const dueAt = started + issued * interval;
        issued++;
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        const [method, path, opts] = scenario.build(issued);
        const p = transport(method, path, opts).then((r) => {
          inFlight--;
          collect(r, dueAt);
        });
        pending.push(p);
        if (pending.length > 20000) pending.splice(0, 10000);
      }
    };
    const timer = setInterval(tick, 1);
  });
}

/**
 * Closed-loop: N workers, each looping. Reported only as a saturation probe -- it finds the
 * throughput ceiling, and its latency percentiles are service time, not response time.
 */
async function runClosed(scenario, workers, seconds, collect) {
  const endAt = performance.now() + seconds * 1000;
  let issued = 0;
  const worker = async () => {
    while (performance.now() < endAt) {
      const dueAt = performance.now();
      const [method, path, opts] = scenario.build(++issued);
      const r = await request(method, path, opts);
      collect(r, dueAt);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return { issued, peakInFlight: workers };
}

/**
 * The generator's own noise floor, measured rather than assumed.
 *
 * The dispatcher wakes on a 1 ms timer and the loop-delay monitor has 1 ms resolution, so
 * both "queue delay" and "event-loop lag" have a floor of roughly a millisecond that exists
 * even against an infinitely fast server. Without measuring it, that floor reads as server
 * queueing -- and at 4000/s, where real p99 is ~3 ms, it would look like a third of the
 * latency. This runs the identical dispatch loop against a transport that returns
 * immediately, so whatever it reports is pure instrument.
 */
async function calibrate(rate, seconds = 2) {
  // Resolves on the microtask queue, not via setImmediate: an immediate would add its own
  // queueing to the number and overstate the floor. Settling synchronously makes
  // doneAt - dueAt exactly the dispatcher's lateness and nothing else.
  const nullTransport = () => {
    const sentAt = performance.now();
    return Promise.resolve({ status: 200, sentAt, doneAt: performance.now(), size: 0, headers: {}, text: '' });
  };
  const loop = monitorEventLoopDelay({ resolution: 1 });
  const dispatch = [];
  const fake = { build: () => ['GET', '/', {}], ok: () => true };
  loop.enable();
  await runOpen(fake, rate, seconds, (r, dueAt) => dispatch.push(r.doneAt - dueAt), nullTransport);
  loop.disable();
  const d = summarize(dispatch);
  return { dispatchP50: d.p50, dispatchP99: d.p99, lagP99: loop.percentile(99) / 1e6, lagMax: loop.max / 1e6 };
}

/**
 * Runs one scenario in THIS process and returns raw samples. Both the parent (when
 * --workers 1) and every forked generator call this; merging happens in the parent.
 */
async function runShare(scenario, { rate, concurrency, duration, warmup }) {
  const loop = monitorEventLoopDelay({ resolution: 1 });

  // Warmup: same traffic, results discarded. The JVM is the reason -- C2 needs thousands of
  // iterations on the hot path -- but it also settles the connection pool and the caches.
  if (warmup > 0) {
    const sink = () => {};
    if (MODE === 'closed') await runClosed(scenario, concurrency, warmup, sink);
    else await runOpen(scenario, rate, warmup, sink);
  }

  const latencies = [];
  const service = [];
  const statuses = new Map();
  let bytes = 0;
  let failures = 0;

  const collect = (r, dueAt) => {
    latencies.push(r.doneAt - dueAt);       // response time, from when it was due
    service.push(r.doneAt - r.sentAt);      // service time, from when it was sent
    bytes += r.size;
    const key = r.error ? `err:${r.error}` : String(r.status);
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
    if (!scenario.ok(r)) failures++;
  };

  loop.enable();
  const wall0 = performance.now();
  const { issued, peakInFlight } = MODE === 'closed'
    ? await runClosed(scenario, concurrency, duration, collect)
    : await runOpen(scenario, rate, duration, collect);
  const wall = (performance.now() - wall0) / 1000;
  loop.disable();

  return {
    latencies, service, bytes, failures, issued, peakInFlight, wall,
    statuses: Object.fromEntries(statuses),
    loopLag: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
  };
}

/** Fans one scenario out across WORKERS generator processes and merges their samples. */
async function runScenario(scenario, fx) {
  const share = {
    rate: RATE / WORKERS,
    concurrency: Math.max(1, Math.round(CONCURRENCY / WORKERS)),
    duration: DURATION,
    warmup: WARMUP,
  };

  let shares;
  if (WORKERS === 1) {
    shares = [await runShare(scenario, share)];
  } else {
    const self = fileURLToPath(import.meta.url);
    shares = await Promise.all(Array.from({ length: WORKERS }, () => new Promise((resolve, reject) => {
      const child = fork(self, ['--child', ...argv], { env: { ...process.env, SB_LOAD_CHILD: '1' } });
      child.once('message', (m) => { resolve(m); child.kill(); });
      child.once('error', reject);
      child.once('exit', (code) => { if (code && code !== 0) reject(new Error(`generator exited ${code}`)); });
      child.send({ fx, scenario: scenario.name, share });
    })));
  }

  // Merge. Percentiles come from the pooled sample, which is what they should be: each
  // worker saw an independent slice of the same offered load.
  const latencies = shares.flatMap((s) => s.latencies);
  const service = shares.flatMap((s) => s.service);
  const statuses = {};
  for (const s of shares) for (const [k, v] of Object.entries(s.statuses)) statuses[k] = (statuses[k] ?? 0) + v;
  const wall = Math.max(...shares.map((s) => s.wall));
  const bytes = shares.reduce((a, s) => a + s.bytes, 0);

  const response = summarize(latencies);
  const serviceTime = summarize(service);
  return {
    scenario: scenario.name,
    title: scenario.title,
    note: scenario.note,
    mode: MODE,
    workers: WORKERS,
    targetRate: MODE === 'closed' ? null : RATE,
    concurrency: MODE === 'closed' ? CONCURRENCY : null,
    seconds: wall,
    issued: shares.reduce((a, s) => a + s.issued, 0),
    completed: latencies.length,
    achievedRate: latencies.length / wall,
    peakInFlight: shares.reduce((a, s) => a + s.peakInFlight, 0),
    failures: shares.reduce((a, s) => a + s.failures, 0),
    bytesPerResponse: latencies.length ? bytes / latencies.length : 0,
    statuses,
    response,
    serviceTime,
    // The gap between the two is the queueing the closed-loop view would have hidden.
    queueDelayP99: response.p99 - serviceTime.p99,
    // Worst loop lag across generators: if any generator stalled, its samples are suspect.
    loopLag: {
      p50: Math.max(...shares.map((s) => s.loopLag.p50)),
      p99: Math.max(...shares.map((s) => s.loopLag.p99)),
      max: Math.max(...shares.map((s) => s.loopLag.max)),
    },
  };
}

// ------------------------------------------------------------------ fixture

/** Builds a realistic environment: many flags, rules, a segment, and both key kinds. */
async function setup() {
  const run = Math.random().toString(36).slice(2, 8);
  const owner = `load-${run}@switchboard.dev`;
  const userToken = `dev:${owner}`;

  const me = await api('GET', '/api/users/me', { token: userToken });
  if (me.status !== 200) throw new Error(`auth failed (${me.status}) — is the backend on ${BASE} running with the local profile?`);

  const org = await api('POST', '/api/orgs', { token: userToken, body: { name: `Load ${run}` } });
  if (org.status !== 201) throw new Error(`org create failed: ${org.status} ${org.text.slice(0, 200)}`);

  const project = await api('POST', `/api/orgs/${org.json.id}/projects`, { token: userToken, body: { key: 'load', name: 'Load' } });
  if (project.status !== 201) throw new Error(`project create failed: ${project.status}`);
  const projectId = project.json.id;
  const prod = project.json.environments.find((e) => e.key === 'production');

  await api('POST', `/api/projects/${projectId}/segments`, {
    token: userToken,
    body: { key: 'load-beta', name: 'Load Beta', includedKeys: Array.from({ length: 500 }, (_, i) => `load-user-${i}`) },
  });

  // Flags: a mix of plain booleans and rule-bearing ones, so the snapshot and the evaluator
  // both have realistic work to do rather than a trivial fallthrough.
  const keys = [];
  for (let i = 0; i < FLAG_COUNT; i++) {
    const key = `load-flag-${i}`;
    const created = await api('POST', `/api/projects/${projectId}/flags`, {
      token: userToken, body: { key, name: `Load Flag ${i}`, kind: 'BOOLEAN' },
    });
    if (created.status !== 201) throw new Error(`flag ${key} failed: ${created.status} ${created.text.slice(0, 200)}`);
    keys.push(key);

    const on = created.json.variations.find((v) => v.value === 'true');
    const off = created.json.variations.find((v) => v.value === 'false');
    // Every third flag carries rules, so evaluation is not uniformly the cheapest case.
    // Rule ids are parsed as UUIDs and `serve` is a RolloutOrVariation, not a bare id.
    const rules = i % 3 === 0 ? [
      { id: uuid(), description: 'pro users', serve: { variationId: on.id }, clauses: [{ attribute: 'plan', op: 'IN', values: ['pro'], negate: false }] },
      { id: uuid(), description: 'modern app', serve: { variationId: on.id }, clauses: [{ attribute: 'appVersion', op: 'SEMVER_GREATER_THAN', values: ['4.2.0'], negate: false }] },
      { id: uuid(), description: 'beta cohort', serve: { variationId: on.id }, clauses: [{ attribute: 'key', op: 'SEGMENT_MATCH', values: ['load-beta'], negate: false }] },
    ] : [];

    const put = await api('PUT', `/api/projects/${projectId}/flags/${key}/environments/production`, {
      token: userToken,
      body: {
        enabled: true, expectedVersion: 1, comment: 'load fixture',
        config: {
          individualTargets: [], rules,
          fallthrough: { rollout: [{ variationId: on.id, weight: 50 }, { variationId: off.id, weight: 50 }] },
          offVariationId: off.id, defaultVariationId: on.id,
        },
      },
    });
    if (put.status !== 200) throw new Error(`targeting ${key} failed: ${put.status} ${put.text.slice(0, 300)}`);

    // Client exposure defaults to false by design; the client bootstrap needs it on.
    await api('PATCH', `/api/projects/${projectId}/flags/${key}`, { token: userToken, body: { clientSideAvailable: true } });
  }

  const serverKeyRes = await api('POST', `/api/environments/${prod.id}/sdk-keys`, { token: userToken, body: { label: 'load-server', kind: 'SERVER' } });
  const clientKeyRes = await api('POST', `/api/environments/${prod.id}/sdk-keys`, { token: userToken, body: { label: 'load-client', kind: 'CLIENT' } });
  if (serverKeyRes.status !== 201 || clientKeyRes.status !== 201) {
    throw new Error(`sdk key mint failed: ${serverKeyRes.status}/${clientKeyRes.status}`);
  }

  const boot = await api('GET', '/api/eval/bootstrap', { token: serverKeyRes.json.key });
  if (boot.status !== 200) throw new Error(`bootstrap failed: ${boot.status}`);

  return {
    orgId: org.json.id, projectId, envId: prod.id,
    serverKey: serverKeyRes.json.key, clientKey: clientKeyRes.json.key,
    userToken, hotFlagKey: keys[0], flagCount: keys.length,
    etag: boot.headers.etag, bootstrapBytes: boot.size,
  };
}

// ------------------------------------------------------------------ actuator

/** Cache and timer meters, so cache behaviour under load is evidence rather than belief. */
async function meters() {
  return new Promise((resolve) => {
    const m = new URL(MGMT);
    http.get({ host: m.hostname, port: m.port, path: '/actuator/prometheus' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        const out = {};
        for (const line of body.split('\n')) {
          if (line.startsWith('#') || !line.trim()) continue;
          const match = /^([a-z_0-9]+)(\{[^}]*\})?\s+([0-9.eE+-]+)$/.exec(line.trim());
          if (!match) continue;
          const [, name, labels = '', value] = match;
          const cache = /cache="([^"]+)"/.exec(labels)?.[1];
          const result = /result="([^"]+)"/.exec(labels)?.[1];
          const key = cache ? `${name}{cache=${cache}${result ? `,result=${result}` : ''}}` : name + labels;
          out[key] = (out[key] ?? 0) + Number(value);
        }
        resolve(out);
      });
    }).on('error', () => resolve(null));
  });
}

function meterDelta(before, after, prefix) {
  if (!before || !after) return null;
  const delta = {};
  for (const key of Object.keys(after)) {
    if (!key.startsWith(prefix)) continue;
    const d = (after[key] ?? 0) - (before[key] ?? 0);
    if (d > 0) delta[key] = d;
  }
  return Object.keys(delta).length ? delta : null;
}

// ------------------------------------------------------------------ reporting

function reportOne(r, floor) {
  const q = r.response;
  console.log(`\n${r.title}`);
  console.log(`  ${r.note}`);
  const rateLine = r.mode === 'closed'
    ? `closed loop · ${r.concurrency} workers`
    : `open loop · target ${r.targetRate}/s`;
  console.log(`  ${rateLine} · achieved ${r.achievedRate.toFixed(1)}/s · ${r.completed} responses · ${(r.bytesPerResponse / 1024).toFixed(1)} kB each`);
  console.log(`  response time ms   p50 ${ms(q.p50)}   p90 ${ms(q.p90)}   p95 ${ms(q.p95)}   p99 ${ms(q.p99)}   p99.9 ${ms(q.p999)}   max ${ms(q.max)}`);
  const queueFloor = floor ? floor.dispatchP99 : 0;
  console.log(`  service time ms    p50 ${ms(r.serviceTime.p50)}   p99 ${ms(r.serviceTime.p99)}    (queue delay at p99: ${ms(r.queueDelayP99)} ms, of which ${ms(queueFloor)} ms is dispatcher floor)`);
  console.log(`  statuses ${JSON.stringify(r.statuses)}${r.failures ? `  ** ${r.failures} unexpected **` : ''}`);
  const excess = floor ? r.loopLag.p99 - floor.lagP99 : r.loopLag.p99;
  console.log(`  generator: event-loop lag p99 ${ms(r.loopLag.p99)} ms (floor ${ms(floor?.lagP99)} ms, excess ${ms(excess)} ms) · peak in-flight ${r.peakInFlight}`);
  // Compared against the measured floor, not against zero: the dispatcher's own 1 ms timer
  // puts ~1-2 ms of lag on the clock no matter how fast the server is.
  if (excess > 0.25 * q.p99) {
    console.log(`  !! generator lag ${(excess).toFixed(1)} ms above floor is ${((excess / q.p99) * 100).toFixed(0)}% of p99 — treat this row as generator-bound, not server-bound`);
  }
  if (r.mode === 'open' && r.achievedRate < r.targetRate * 0.95) {
    console.log(`  !! achieved rate is ${((r.achievedRate / r.targetRate) * 100).toFixed(0)}% of target — the server or the generator could not keep up`);
  }
}

// ------------------------------------------------------------------ main

/**
 * Forked generator process: take a fixture and a scenario name over IPC, run this
 * process's share of the offered load, post the raw samples back. No setup, no output --
 * the parent owns both.
 */
function runAsChild() {
  process.on('message', async ({ fx, scenario: name, share }) => {
    const scenario = buildScenarios(fx).find((s) => s.name === name);
    const result = await runShare(scenario, share);
    process.send(result);
    agent.destroy();
  });
}

async function main() {
  console.log(`Switchboard load harness — ${BASE}`);
  console.log(`mode=${MODE} ${MODE === 'closed' ? `concurrency=${CONCURRENCY}` : `rate=${RATE}/s`} warmup=${WARMUP}s duration=${DURATION}s sockets=${SOCKETS} generators=${WORKERS}\n`);

  process.stdout.write('setting up fixture… ');
  const fx = await setup();
  console.log(`${fx.flagCount} flags, segment of 500, server+client keys, bootstrap ${(fx.bootstrapBytes / 1024).toFixed(1)} kB`);

  process.stdout.write('calibrating generator noise floor… ');
  const floor = await calibrate(RATE / WORKERS);
  console.log(`dispatch p99 ${ms(floor.dispatchP99)} ms, loop lag p99 ${ms(floor.lagP99)} ms (per generator, at ${(RATE / WORKERS).toFixed(0)}/s)`);

  const scenarios = buildScenarios(fx).filter((s) => !ONLY || s.name === ONLY);
  if (!scenarios.length) {
    console.error(`No scenario named "${ONLY}". Known: ${buildScenarios(fx).map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const results = [];
  for (const scenario of scenarios) {
    if (!QUIET) process.stdout.write(`\nrunning ${scenario.name}…`);
    const before = await meters();
    const r = await runScenario(scenario, fx);
    const after = await meters();
    r.cacheDelta = meterDelta(before, after, 'cache_');
    r.dbDelta = meterDelta(before, after, 'switchboard_');
    results.push(r);
    if (!QUIET) process.stdout.write('\r');
    r.floor = floor;
    reportOne(r, floor);
    if (r.cacheDelta) console.log(`  caches: ${Object.entries(r.cacheDelta).map(([k, v]) => `${k.replace('cache_gets_total', 'gets')}=${v}`).join(' ')}`);
  }

  const totalFailures = results.reduce((a, r) => a + r.failures, 0);
  console.log(`\n${results.length} scenario(s), ${results.reduce((a, r) => a + r.completed, 0)} responses, ${totalFailures} unexpected status.`);

  if (JSON_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(JSON_OUT, JSON.stringify({
      base: BASE, mode: MODE, rate: RATE, concurrency: CONCURRENCY,
      duration: DURATION, warmup: WARMUP, flags: fx.flagCount,
      bootstrapBytes: fx.bootstrapBytes, at: new Date().toISOString(), results,
    }, null, 2));
    console.log(`Wrote ${JSON_OUT}`);
  }

  agent.destroy();
  if (totalFailures) process.exit(1);
}

if (process.env.SB_LOAD_CHILD) {
  runAsChild();
} else {
  main().catch((e) => {
    console.error('\nLoad harness failed:', e.message);
    process.exit(1);
  });
}
