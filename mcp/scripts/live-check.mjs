#!/usr/bin/env node
/**
 * Drives every MCP tool against a running stack, through a real personal access token.
 *
 * Same house style as the other live checks: zero dependencies, `check(name, cond)`, exit 0 or 1.
 * The point is the same too — these catch contract drift that unit tests cannot, because the tools
 * are a thin layer over REST and a REST change breaks them silently.
 *
 * Usage: node mcp/scripts/live-check.mjs
 *   API_BASE_URL   default http://localhost:28080
 *   OWNER_EMAIL    default alice@switchboard.dev (a dev token mints the PAT)
 */

import { SwitchboardClient } from '../dist/client.js';
import { TOOLS } from '../dist/tools.js';

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:28080';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'alice@switchboard.dev';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function tool(name) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer dev:${OWNER_EMAIL}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function main() {
  console.log(`MCP live check against ${BASE_URL}\n`);

  // Mint a real PAT with a dev token, then use ONLY the PAT from here on. That is the property
  // under test: an agent authenticates with a token, not with an interactive session.
  const created = await api('/api/users/me/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: `mcp-live-check-${Date.now()}` }),
  });
  check('minted a personal access token', typeof created.token === 'string');
  check('token has the expected prefix', created.token.startsWith('sb_pat_'));

  const client = new SwitchboardClient({ baseUrl: BASE_URL, token: created.token });

  try {
    const projects = await tool('list_projects').run(client, {});
    check('list_projects returns orgs with projects', Array.isArray(projects) && projects.length > 0);

    const org = projects[0];
    const project = org.projects[0];
    check('a project has environments', Array.isArray(project.environments) && project.environments.length > 0);
    const production = project.environments.find((e) => e.key === 'production') ?? project.environments[0];

    const flags = await tool('list_flags').run(client, { projectId: project.id, limit: 50 });
    check('list_flags returns items', Array.isArray(flags.items));
    check('list_flags found seeded flags', flags.items.length > 0, `got ${flags.items.length}`);

    const flagKey = flags.items[0].key;
    const flag = await tool('get_flag').run(client, { projectId: project.id, flagKey });
    check('get_flag returns variations', Array.isArray(flag.variations) && flag.variations.length > 0);
    check('get_flag returns per-environment configs', Array.isArray(flag.envConfigs));

    const envConfig = flag.envConfigs.find((c) => c.envKey === production.key);
    check('get_flag exposes the version update_targeting needs', typeof envConfig?.version === 'number');

    const versions = await tool('list_versions').run(client, {
      projectId: project.id, flagKey, envKey: production.key,
    });
    // The API wraps history as { items: [...] }, like the other paged reads. The tool returns the
    // response as-is rather than unwrapping it, so an agent sees the same shape the REST docs show.
    const versionItems = versions.items ?? versions;
    check('list_versions returns history', Array.isArray(versionItems) && versionItems.length > 0);
    check('a version carries the number rollback needs',
      typeof versionItems[0]?.versionNumber === 'number');

    // A write, through the versioned path, with the version we just read.
    const write = await tool('update_targeting').run(client, {
      projectId: project.id,
      flagKey,
      envKey: production.key,
      enabled: envConfig.enabled,
      config: envConfig.config,
      expectedVersion: envConfig.version,
      comment: 'mcp live check: no-op rewrite',
    });
    check('update_targeting reports applied or queued explicitly',
      write.applied === true || write.queued === true);
    check('a queued write is never reported as applied',
      write.applied === true ? true : String(write.summary).includes('NOT applied'));

    // The stale-version guard: the same expectedVersion cannot work twice.
    let conflicted = false;
    try {
      await tool('update_targeting').run(client, {
        projectId: project.id,
        flagKey,
        envKey: production.key,
        enabled: envConfig.enabled,
        config: envConfig.config,
        expectedVersion: envConfig.version,
        comment: 'mcp live check: should conflict',
      });
    } catch (error) {
      conflicted = /409|conflict|re-read/i.test(String(error.message));
    }
    check('a stale expectedVersion is refused rather than clobbering', conflicted || write.queued === true);

    const anomalies = await tool('list_anomalies').run(client, { environmentId: production.id });
    check('list_anomalies returns a list', Array.isArray(anomalies));

    const stats = await tool('get_rollout_stats').run(client, {
      environmentId: production.id, flagKey, hours: 48,
    });
    check('get_rollout_stats returns per-variation totals', Array.isArray(stats.totals));

    const audit = await tool('list_audit').run(client, { projectId: project.id, limit: 10 });
    check('list_audit returns entries', Array.isArray(audit.items ?? audit));

    const requests = await tool('list_change_requests').run(client, { projectId: project.id });
    check('list_change_requests returns a list', Array.isArray(requests.items ?? requests));

    // Revocation must actually stop the token working.
    await api(`/api/users/me/tokens/${created.id}`, { method: 'DELETE' });
    let rejected = false;
    try {
      await tool('list_projects').run(client, {});
    } catch (error) {
      rejected = /401/.test(String(error.message));
    }
    check('a revoked token stops working immediately', rejected);
  } finally {
    // Best effort: the token may already be revoked by the check above.
    await api(`/api/users/me/tokens/${created.id}`, { method: 'DELETE' }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nlive-check crashed: ${error.message}`);
  process.exit(1);
});
