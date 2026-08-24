#!/usr/bin/env node
/**
 * Live service-layer check for the Switchboard app.
 *
 * Exercises the exact URLs and payload shapes features/*\/services build, against
 * the local backend, and spot-asserts that every response field the TS mirrors in
 * shared/api/types.ts declare is actually present and the right type. Plain node:
 * no RN, no bundler, no simulator.
 *
 *   node scripts/service-check.mjs [--base http://localhost:28080] [--as alice@ex.com]
 *
 * Writes only to a throwaway flag it creates and archives at the end.
 * Prints PASS/FAIL lines; exits 0 when everything passed, 1 otherwise.
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argValue('--base', process.env.SWITCHBOARD_API ?? 'http://localhost:28080');
const ACTOR = argValue('--as', 'alice@ex.com');
const PROJECT_KEY = argValue('--project', 'storefront-app');
const TOKEN = `dev:${ACTOR}`;

let passed = 0;
let failed = 0;

function pass(message) {
  passed += 1;
  console.log(`PASS  ${message}`);
}

function fail(message, detail) {
  failed += 1;
  console.log(`FAIL  ${message}${detail ? ` — ${detail}` : ''}`);
}

function check(condition, message, detail) {
  if (condition) pass(message);
  else fail(message, detail);
}

/** Asserts a response object carries every field the TS mirror declares. */
function checkShape(label, value, spec) {
  const problems = [];
  for (const [field, kind] of Object.entries(spec)) {
    const optional = kind.endsWith('?');
    const type = optional ? kind.slice(0, -1) : kind;
    const actual = value?.[field];
    if (actual === undefined || actual === null) {
      if (!optional) problems.push(`${field} missing`);
      continue;
    }
    const actualType = Array.isArray(actual) ? 'array' : typeof actual;
    if (actualType !== type) problems.push(`${field} is ${actualType}, expected ${type}`);
  }
  check(problems.length === 0, `${label} matches shared/api/types.ts`, problems.join('; '));
}

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const error = new Error(
      `${method} ${path} → ${response.status} ${payload?.message ?? text ?? ''}`.trim(),
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** Ramp rewrite mirroring features/flags/lib/targeting.ts withRampPercent. */
function withRampPercent(config, percent) {
  const current = config.fallthrough.rollout ?? [];
  const other =
    current.find((w) => w.variationId !== config.defaultVariationId)?.variationId ??
    config.offVariationId;
  return {
    ...config,
    fallthrough: {
      rollout: [
        { variationId: config.defaultVariationId, weight: percent },
        { variationId: other, weight: 100 - percent },
      ],
    },
  };
}

function rampPercentage(config) {
  const rollout = config.fallthrough.rollout ?? [];
  if (rollout.length === 0) return null;
  return rollout.find((w) => w.variationId === config.defaultVariationId)?.weight ?? null;
}

async function main() {
  console.log(`Switchboard service check — ${BASE} as ${ACTOR}\n`);
  let throwawayKey = null;
  let projectId = null;

  try {
    // ---- /api/users/me → memberships (org bootstrapping) ----
    const me = await api('GET', '/api/users/me');
    checkShape('UserResponse', me, {
      id: 'string',
      email: 'string',
      onboardingCompleted: 'boolean',
      memberships: 'array',
    });
    const membership = me.memberships[0];
    checkShape('UserMembership', membership, {
      orgId: 'string',
      orgName: 'string',
      orgSlug: 'string',
      role: 'string',
    });
    const orgId = membership.orgId;

    // ---- org members / settings (Settings tab) ----
    const members = await api('GET', `/api/orgs/${orgId}/members`);
    checkShape('OrgMemberResponse', members[0], {
      userId: 'string',
      email: 'string',
      role: 'string',
      joinedAt: 'string',
    });
    const settings = await api('GET', `/api/orgs/${orgId}/settings`);
    checkShape('OrgSettingsResponse', settings, {
      aiEnabled: 'boolean',
      autoRollbackEnabled: 'boolean',
      autoOptimizeEnabled: 'boolean?',
      staleFlagWeeks: 'number',
    });
    check(
      'autoOptimizeEnabled' in settings,
      'OrgSettingsResponse carries autoOptimizeEnabled',
      'field absent — backend AI layer has not shipped it yet (spec marks it required)',
    );

    // ---- projects + embedded environments (activeProject / activeEnv) ----
    const projects = await api('GET', `/api/orgs/${orgId}/projects`);
    const project = projects.find((p) => p.key === PROJECT_KEY) ?? projects[0];
    projectId = project.id;
    checkShape('ProjectResponse', project, {
      id: 'string',
      orgId: 'string',
      key: 'string',
      name: 'string',
      environments: 'array',
    });
    checkShape('EnvironmentResponse', project.environments[0], {
      id: 'string',
      projectId: 'string',
      key: 'string',
      name: 'string',
      stateVersion: 'number',
    });
    const envKeys = project.environments.map((e) => e.key);
    check(envKeys.includes('production'), `project ${project.key} has a production env`, envKeys.join(','));

    // ---- flags list (Flags tab) ----
    const list = await api('GET', `/api/projects/${projectId}/flags`);
    checkShape('FlagListResponse', list, { items: 'array' });
    const summary = list.items[0];
    checkShape('FlagSummaryResponse', summary, {
      id: 'string',
      key: 'string',
      name: 'string',
      kind: 'string',
      tags: 'array',
      environments: 'array',
    });
    checkShape('FlagEnvSummary', summary.environments[0], {
      envKey: 'string',
      enabled: 'boolean',
      killSwitchActive: 'boolean',
      version: 'number',
      rolloutPercentage: 'number?',
      updatedAt: 'string?',
      updatedBy: 'string?',
    });

    // ---- flags list with the ?query filter the service exposes ----
    const filtered = await api(
      'GET',
      `/api/projects/${projectId}/flags?query=${encodeURIComponent(summary.key.slice(0, 4))}`,
    );
    check(
      filtered.items.some((f) => f.key === summary.key),
      'flags list ?query returns the matching flag',
    );

    // ---- flag detail (detail screen) ----
    const detail = await api('GET', `/api/projects/${projectId}/flags/${summary.key}`);
    checkShape('FlagDetailResponse', detail, {
      id: 'string',
      projectId: 'string',
      key: 'string',
      name: 'string',
      kind: 'string',
      variations: 'array',
      tags: 'array',
      envConfigs: 'array',
    });
    checkShape('FlagEnvConfigResponse', detail.envConfigs[0], {
      flagId: 'string',
      environmentId: 'string',
      envKey: 'string',
      enabled: 'boolean',
      killSwitchActive: 'boolean',
      config: 'object',
      version: 'number',
      updatedAt: 'string',
      updatedBy: 'string',
    });
    checkShape('FlagTargetingConfig', detail.envConfigs[0].config, {
      fallthrough: 'object',
      offVariationId: 'string',
      defaultVariationId: 'string',
      individualTargets: 'array?',
      rules: 'array?',
    });

    // ---- create a THROWAWAY flag (create sheet) ----
    throwawayKey = `zz-service-check-${Date.now()}`;
    const created = await api('POST', `/api/projects/${projectId}/flags`, {
      key: throwawayKey,
      name: 'Service check throwaway',
      kind: 'BOOLEAN',
      tags: ['service-check'],
    });
    check(created.key === throwawayKey, 'POST flags creates the flag');
    check(
      created.envConfigs.length === project.environments.length,
      'created flag seeds one config per environment',
      `${created.envConfigs.length} configs vs ${project.environments.length} envs`,
    );

    const envKey = 'production';
    const prod = () =>
      api('GET', `/api/projects/${projectId}/flags/${throwawayKey}`).then((f) =>
        f.envConfigs.find((e) => e.envKey === envKey),
      );

    // ---- kill switch on / off (long-press on the card) ----
    const killedOn = await api(
      'POST',
      `/api/projects/${projectId}/flags/${throwawayKey}/environments/${envKey}/kill-switch`,
      { active: true, reason: 'service check' },
    );
    check(killedOn.killSwitchActive === true, 'kill switch ON flips killSwitchActive');
    const killedOff = await api(
      'POST',
      `/api/projects/${projectId}/flags/${throwawayKey}/environments/${envKey}/kill-switch`,
      { active: false, reason: 'service check' },
    );
    check(killedOff.killSwitchActive === false, 'kill switch OFF clears killSwitchActive');
    check(
      killedOff.version > killedOn.version,
      'each kill-switch write bumps the version',
      `${killedOn.version} → ${killedOff.version}`,
    );

    // ---- ramp PUT with expectedVersion (RampSlider) ----
    const beforeRamp = await prod();
    const ramped = await api(
      'PUT',
      `/api/projects/${projectId}/flags/${throwawayKey}/environments/${envKey}`,
      {
        enabled: true,
        config: withRampPercent(beforeRamp.config, 25),
        expectedVersion: beforeRamp.version,
        comment: 'ramp 25%',
      },
    );
    check(rampPercentage(ramped.config) === 25, 'ramp PUT writes a 25% two-way rollout');
    check(ramped.enabled === true, 'ramp PUT carries the enabled flag through');

    // The list summary must now surface the same percentage the slider reads back.
    const afterRampList = await api('GET', `/api/projects/${projectId}/flags`);
    const rampedSummary = afterRampList.items
      .find((f) => f.key === throwawayKey)
      ?.environments.find((e) => e.envKey === envKey);
    check(
      rampedSummary?.rolloutPercentage === 25,
      'list FlagEnvSummary.rolloutPercentage mirrors the config ramp',
      `got ${rampedSummary?.rolloutPercentage}`,
    );

    // ---- stale expectedVersion must 409 (the conflict banner path) ----
    let conflicted = false;
    try {
      await api('PUT', `/api/projects/${projectId}/flags/${throwawayKey}/environments/${envKey}`, {
        enabled: true,
        config: withRampPercent(ramped.config, 50),
        expectedVersion: beforeRamp.version,
        comment: 'ramp 50%',
      });
    } catch (e) {
      conflicted = e.status === 409;
    }
    check(conflicted, 'stale expectedVersion returns 409 CONFLICT');

    // ---- versions + rollback (history screen) ----
    const versions = await api(
      'GET',
      `/api/projects/${projectId}/flags/${throwawayKey}/environments/${envKey}/versions`,
    );
    checkShape('FlagVersionListResponse', versions, { items: 'array' });
    checkShape('FlagVersionResponse', versions.items[0], {
      versionNumber: 'number',
      enabled: 'boolean',
      killSwitchActive: 'boolean',
      config: 'object',
      createdBy: 'string',
      createdAt: 'string',
      versionNote: 'string?',
    });
    check(
      versions.items[0].versionNumber > versions.items[versions.items.length - 1].versionNumber,
      'versions come back newest first',
    );

    const target = versions.items.find((v) => v.versionNumber === 1);
    const rolledBack = await api(
      'POST',
      `/api/projects/${projectId}/flags/${throwawayKey}/environments/${envKey}/rollback`,
      { toVersion: target.versionNumber, reason: 'service check rollback' },
    );
    check(
      rampPercentage(rolledBack.config) === rampPercentage(target.config),
      'rollback restores the target snapshot config',
    );
    check(
      rolledBack.version > versions.items[0].versionNumber,
      'rollback writes a NEW version rather than rewinding',
      `${versions.items[0].versionNumber} → ${rolledBack.version}`,
    );

    // ---- audit feeds (Activity tab) ----
    const orgAudit = await api('GET', `/api/orgs/${orgId}/audit?limit=10`);
    checkShape('AuditListResponse', orgAudit, { items: 'array', nextCursor: 'string?' });
    checkShape('AuditEntryResponse', orgAudit.items[0], {
      id: 'string',
      orgId: 'string',
      action: 'string',
      actor: 'string',
      createdAt: 'string',
      projectId: 'string?',
      envKey: 'string?',
      flagKey: 'string?',
      reason: 'string?',
      versionFrom: 'number?',
      versionTo: 'number?',
    });
    check(
      orgAudit.items.some((e) => e.flagKey === throwawayKey && e.action === 'ROLLBACK'),
      'org audit records the rollback we just made',
    );
    if (orgAudit.nextCursor) {
      const page2 = await api(
        'GET',
        `/api/orgs/${orgId}/audit?limit=10&cursor=${encodeURIComponent(orgAudit.nextCursor)}`,
      );
      const firstPageIds = new Set(orgAudit.items.map((e) => e.id));
      check(
        page2.items.every((e) => !firstPageIds.has(e.id)),
        'audit keyset cursor returns a disjoint next page',
      );
    }

    const projectAudit = await api('GET', `/api/projects/${projectId}/audit?limit=5`);
    check(
      projectAudit.items.every((e) => e.projectId === projectId),
      'project audit is scoped to the project',
    );

    // ---- SDK keys (Settings → SDK keys) ----
    const prodEnv = project.environments.find((e) => e.key === envKey);
    const sdkKeys = await api('GET', `/api/environments/${prodEnv.id}/sdk-keys`);
    check(Array.isArray(sdkKeys), 'SDK key list returns an array');
    if (sdkKeys.length > 0) {
      checkShape('SdkKeyResponse', sdkKeys[0], {
        id: 'string',
        environmentId: 'string',
        keyPrefix: 'string',
        createdAt: 'string',
        label: 'string?',
        revokedAt: 'string?',
      });
      check(!('key' in sdkKeys[0]), 'SDK key list never returns the full key');
    }

    // Create + revoke a throwaway key (one-time reveal, then the revoke path).
    const newKey = await api('POST', `/api/environments/${prodEnv.id}/sdk-keys`, {
      label: 'service check',
    });
    checkShape('SdkKeyCreatedResponse', newKey, {
      id: 'string',
      environmentId: 'string',
      key: 'string',
      keyPrefix: 'string',
      createdAt: 'string',
      label: 'string?',
    });
    // keyPrefix already carries a trailing ellipsis, so compare against its stem.
    const prefixStem = newKey.keyPrefix.replace(/[….]+$/u, '');
    check(
      typeof newKey.key === 'string' &&
        newKey.key.startsWith(prefixStem) &&
        newKey.key.length > prefixStem.length,
      'create returns the full key, matching the keyPrefix stem',
      `key=${newKey.key?.slice(0, 12)}… prefix=${newKey.keyPrefix}`,
    );
    await api('DELETE', `/api/sdk-keys/${newKey.id}`);
    const afterRevoke = await api('GET', `/api/environments/${prodEnv.id}/sdk-keys`);
    const revoked = afterRevoke.find((k) => k.id === newKey.id);
    check(!!revoked?.revokedAt, 'revoke stamps revokedAt on the key');
  } catch (e) {
    fail('unexpected error', e.message);
  } finally {
    if (throwawayKey && projectId) {
      try {
        await api('DELETE', `/api/projects/${projectId}/flags/${throwawayKey}`);
        pass(`archived throwaway flag ${throwawayKey}`);
      } catch (e) {
        fail(`archive throwaway flag ${throwawayKey}`, e.message);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  service check crashed — ${e.message}`);
  process.exit(1);
});
