// Stage the state a few demo screens need, through the public API:
//   - staging requires approval, and bob proposes a change there -> a pending change request
//   - a pending invitation on the Organization tab
//   - a webhook filtered to incident events on the Webhooks tab
// Approval is turned on in STAGING, not production, so the healing loop in production is untouched.
// Not idempotent: run once per fresh seed, after heal-scenario.mjs.
import { ALICE, BOB, api, workspace } from './lib.mjs';

const { orgId, projectId, envs } = await workspace();

await api('PUT', `/api/environments/${envs.staging.id}/approval-settings`, ALICE, { requireApproval: true, minApprovals: 1 });
console.log('staging now requires 1 approval');

// bob proposes widening new-checkout in staging from 50% to 75%
const path = `/api/projects/${projectId}/flags/new-checkout`;
const flag = (await api('GET', path, BOB)).body;
const st = flag.envConfigs.find((c) => c.envKey === 'staging');
const on = flag.variations.find((v) => v.value === 'true').id;
const off = flag.variations.find((v) => v.value === 'false').id;
const res = await api('PUT', `${path}/environments/staging`, BOB, {
  enabled: true, expectedVersion: st.version, comment: 'widen staging to 75% before the production ramp',
  config: { ...st.config, fallthrough: { rollout: [{ variationId: on, weight: 75 }, { variationId: off, weight: 25 }] } },
});
if (res.status !== 202) throw new Error(`expected 202 (queued for approval), got ${res.status}`);
console.log("bob's staging edit -> 202, queued for approval");

await api('POST', `/api/orgs/${orgId}/invitations`, ALICE, { email: 'dana@acme-mobile.dev', role: 'MEMBER' });
console.log('invited dana@acme-mobile.dev (pending)');

await api('POST', `/api/orgs/${orgId}/webhooks`, ALICE, {
  url: 'https://hooks.acme-mobile.dev/switchboard', description: 'Incident channel relay',
  eventTypes: ['flag.kill_switch', 'flag.rollback', 'rollout.finding'],
});
console.log('webhook created (kill switch, rollback, monitor findings)');
