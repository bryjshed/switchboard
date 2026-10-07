// Stage a real AI rollback on top of a fresh `make seed`.
//
// The seed's healing flag (payment-provider-v2) is killed before its scan runs, and the monitor never
// scans a killed flag, so a plain seed never shows healing. This creates payment-provider-v3 at 50/50
// in production with a treatment that errors ~20% vs ~2%, turns on auto-rollback, feeds 48h of
// backdated traffic exactly the way seed-local.mjs does, and runs the rollout scan. The monitor then
// rolls it back itself: a finding, a new version by switchboard-monitor, and an audit row marked AI.
//
// Not idempotent: run once per fresh seed.
import { ALICE, API, JOB_TOKEN, api, psql, workspace } from './lib.mjs';

const FLAG = 'payment-provider-v3';
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const { orgId, projectId: P, envs } = await workspace();

// a production server key of our own, so this does not depend on the seed's printed keys
const sdkKey = (await api('POST', `/api/environments/${envs.production.id}/sdk-keys`, ALICE, { label: 'demo capture' })).body.key;

await api('PUT', `/api/orgs/${orgId}/settings`, ALICE, { autoRollbackEnabled: true });
console.log('auto-rollback enabled for Acme Mobile');

const flag = (await api('POST', `/api/projects/${P}/flags`, ALICE, {
  key: FLAG, name: 'Payment provider v3', kind: 'BOOLEAN', tags: ['payments', 'revenue'],
  description: 'Switches card processing to the v3 provider SDK',
})).body;
const on = flag.variations.find((v) => v.value === 'true').id;
const off = flag.variations.find((v) => v.value === 'false').id;
await api('PUT', `/api/projects/${P}/flags/${FLAG}/environments/production`, ALICE, {
  enabled: true, expectedVersion: 1, comment: 'ramp v3 provider to 50%',
  config: {
    individualTargets: [], rules: [],
    fallthrough: { rollout: [{ variationId: on, weight: 50 }, { variationId: off, weight: 50 }] },
    offVariationId: off, defaultVariationId: on,
  },
});

// 1600 subjects, 50/50: 800 per arm clears min-subjects (200) with room, and a 20% vs 2% error gap
// is far past the heal threshold (alpha 0.05 -> E >= 20) at that size.
const evals = [], metrics = [];
for (let i = 0; i < 1600; i++) {
  const user = `user-${i}`;
  const h = (i % 47) + Math.random();
  const treated = i % 2 === 0;
  evals.push({ flagKey: FLAG, contextKey: user, variationId: treated ? on : off, reason: 'ROLLOUT', occurredAt: hoursAgo(h) });
  if (Math.random() < (treated ? 0.2 : 0.02)) metrics.push({ contextKey: user, metricKey: 'error', value: 1, occurredAt: hoursAgo(h) });
}
for (let i = 0; i < evals.length; i += 400) await api('POST', '/api/events/eval', sdkKey, { events: evals.slice(i, i + 400) });
for (let i = 0; i < metrics.length; i += 400) await api('POST', '/api/events/metrics', sdkKey, { events: metrics.slice(i, i + 400) });
console.log(`${evals.length} eval + ${metrics.length} error events ingested`);

// Same backdating, for the same reason, as seed-local.mjs: evidence counts from the allocation epoch.
psql(`UPDATE flag_env_config_versions SET created_at = now() - interval '72 hours' WHERE flag_id = (SELECT id FROM flags WHERE key = '${FLAG}')`);

const res = await fetch(`${API}/api/jobs/rollout-scan`, { method: 'POST', headers: { 'X-Job-Token': JOB_TOKEN } });
console.log(`rollout-scan: ${res.status} ${(await res.text()).slice(0, 200)}`);
const versions = (await api('GET', `/api/projects/${P}/flags/${FLAG}/environments/production/versions`, ALICE)).body.items;
const head = versions[0];
if (head.createdBy !== 'switchboard-monitor') throw new Error(`expected an AI rollback at the head, got v${head.versionNumber} by ${head.createdBy}`);
console.log(`v${head.versionNumber} written by ${head.createdBy}: ${head.versionNote.slice(0, 120)}…`);
