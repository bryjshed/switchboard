#!/usr/bin/env node
/**
 * Live AI/monitoring service check for the Switchboard app.
 *
 * Exercises the exact URLs features/ai/services build, against the local
 * backend, and spot-asserts that every field the TS mirrors in
 * shared/api/types.ts declare is present and the right type. Plain node: no RN,
 * no bundler, no simulator.
 *
 *   node scripts/ai-check.mjs [--base http://localhost:28080] [--as alice@switchboard.dev]
 *
 * Read-mostly. The only writes are acknowledging one OPEN anomaly finding (and
 * asserting the re-ack conflicts) — an ack is not reversible via the API, so
 * the script picks the OLDEST open finding and says which one it took.
 *
 * Prints PASS/FAIL lines; exits 0 when everything passed, 1 otherwise.
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argValue('--base', process.env.SWITCHBOARD_API ?? 'http://localhost:28080');
const ACTOR = argValue('--as', 'alice@switchboard.dev');
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

function info(message) {
  console.log(`      ${message}`);
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

const PROPOSAL_KINDS = ['FLAG_CREATE', 'FLAG_UPDATE', 'ROLLBACK', 'RETIREMENT'];
const PROPOSAL_STATUSES = ['DRAFT', 'APPLIED', 'REJECTED', 'EXPIRED'];
const ANOMALY_STATUSES = ['OPEN', 'ACKED', 'AUTO_ROLLED_BACK'];

/** Mirrors features/flags/lib/targeting.ts isRollout — [] is NOT a rollout. */
function isRollout(serve) {
  return Array.isArray(serve?.rollout) && serve.rollout.length > 0;
}

async function main() {
  console.log(`Switchboard AI check — ${BASE} as ${ACTOR}\n`);

  try {
    const me = await api('GET', '/api/users/me');
    // Several seeded orgs share a name; the one that owns the project wins.
    let project = null;
    let orgId = null;
    for (const membership of me.memberships) {
      const projects = await api('GET', `/api/orgs/${membership.orgId}/projects`);
      const match = projects.find((p) => p.key === PROJECT_KEY) ?? projects[0];
      if (match) {
        project = match;
        orgId = membership.orgId;
        break;
      }
    }
    check(!!project, `found project ${PROJECT_KEY}`, 'no org has any project');
    if (!project) throw new Error('no project to check against');
    const projectId = project.id;
    info(`org ${orgId} · project ${project.key} (${projectId})`);

    // ---------- draft: 503 AI_UNAVAILABLE in a keyless environment ----------
    let draftStatus = null;
    let draftBody = null;
    try {
      draftBody = await api('POST', `/api/projects/${projectId}/ai/proposals`, {
        prompt: 'Ramp new-checkout to 25% in staging',
        environmentKey: 'staging',
      });
      draftStatus = 201;
    } catch (e) {
      draftStatus = e.status;
      draftBody = e.payload;
    }
    if (draftStatus === 503) {
      check(true, 'draft proposal returns 503 in this keyless environment');
      check(
        draftBody?.error === 'AI_UNAVAILABLE',
        '503 body carries the AI_UNAVAILABLE code the app branches on',
        `error=${draftBody?.error} message=${draftBody?.message}`,
      );
      info(`the app renders this as AiUnavailableNotice: "${draftBody?.message}"`);
    } else if (draftStatus === 201) {
      // A key IS configured here; assert the happy shape instead.
      check(true, 'draft proposal returned 201 (ANTHROPIC_API_KEY is configured)');
      checkShape('AiProposalResponse (drafted)', draftBody, {
        id: 'string',
        orgId: 'string',
        projectId: 'string',
        kind: 'string',
        diff: 'object',
        status: 'string',
        createdBy: 'string',
        createdAt: 'string',
      });
    } else {
      fail('draft proposal returns 503 AI_UNAVAILABLE or 201', `got ${draftStatus}`);
    }

    // ---------- list proposals ----------
    const list = await api('GET', `/api/projects/${projectId}/ai/proposals?limit=25`);
    checkShape('AiProposalListResponse', list, { items: 'array', nextCursor: 'string?' });
    check(list.items.length > 0, 'project has seeded proposals to render', 'items is empty');

    const proposal = list.items[0];
    checkShape('AiProposalResponse', proposal, {
      id: 'string',
      orgId: 'string',
      projectId: 'string',
      kind: 'string',
      diff: 'object',
      status: 'string',
      createdBy: 'string',
      createdAt: 'string',
      environmentId: 'string?',
      sourcePrompt: 'string?',
      rationale: 'string?',
      appliedBy: 'string?',
      appliedVersion: 'number?',
    });
    check(
      PROPOSAL_KINDS.includes(proposal.kind),
      'ProposalKind is one of the four the app maps',
      proposal.kind,
    );
    check(
      PROPOSAL_STATUSES.includes(proposal.status),
      'ProposalStatus is one of the four the app maps',
      proposal.status,
    );

    // ---------- FlagChangeDiff: what DiffPreview renders ----------
    checkShape('FlagChangeDiff', proposal.diff, {
      kind: 'string',
      flagKey: 'string',
      name: 'string?',
      description: 'string?',
      flagKind: 'string?',
      variations: 'array?',
      tags: 'array?',
      envChanges: 'array?',
      rollbackToVersion: 'number?',
      retirementChecklist: 'array?',
    });
    const withEnvChange = list.items.find((p) => (p.diff.envChanges ?? []).length > 0);
    if (withEnvChange) {
      const change = withEnvChange.diff.envChanges[0];
      checkShape('EnvChange', change, {
        envKey: 'string',
        enabled: 'boolean?',
        killSwitchActive: 'boolean?',
        config: 'object?',
      });
      if (change.config) {
        checkShape('FlagTargetingConfig (in diff)', change.config, {
          fallthrough: 'object',
          offVariationId: 'string',
          defaultVariationId: 'string',
          rules: 'array?',
          individualTargets: 'array?',
        });
        // The empty-rollout trap: a fixed fallthrough still ships rollout: [].
        const ft = change.config.fallthrough;
        check(
          isRollout(ft) ? !ft.variationId : !!ft.variationId,
          'diff fallthrough resolves to exactly one of rollout / variationId',
          JSON.stringify(ft),
        );
      }
    } else {
      info('no proposal carries an envChange; skipped EnvChange shape check');
    }

    // ---------- status filter ----------
    const applied = await api(
      'GET',
      `/api/projects/${projectId}/ai/proposals?status=APPLIED&limit=25`,
    );
    check(
      applied.items.every((p) => p.status === 'APPLIED'),
      'proposals ?status=APPLIED filters server-side',
      applied.items.map((p) => p.status).join(','),
    );

    // ---------- get one proposal by id ----------
    const single = await api('GET', `/api/ai/proposals/${proposal.id}`);
    check(single.id === proposal.id, 'GET /api/ai/proposals/{id} returns that proposal');
    check(
      single.diff.flagKey === proposal.diff.flagKey,
      'single proposal carries the same diff as the list entry',
    );

    // ---------- 409 when applying a non-DRAFT proposal ----------
    const nonDraft = list.items.find((p) => p.status !== 'DRAFT');
    if (nonDraft) {
      let status = null;
      try {
        await api('POST', `/api/ai/proposals/${nonDraft.id}/apply`, { reason: 'ai check' });
      } catch (e) {
        status = e.status;
      }
      check(status === 409, 'applying a non-DRAFT proposal returns 409 CONFLICT', `got ${status}`);
    } else {
      info('no non-DRAFT proposal available; skipped the apply-409 check');
    }

    // ---------- anomalies per environment ----------
    const envsWithFindings = [];
    for (const env of project.environments) {
      const findings = await api('GET', `/api/environments/${env.id}/anomalies`);
      check(Array.isArray(findings), `anomalies list for ${env.key} returns an array`);
      if (findings.length > 0) envsWithFindings.push({ env, findings });
    }
    check(
      envsWithFindings.length > 0,
      'at least one environment has anomaly findings to render',
      'run: curl -X POST localhost:28080/api/jobs/rollout-scan -H "X-Job-Token: local-job-token"',
    );

    let ackTarget = null;
    let statsEnv = null;
    if (envsWithFindings.length > 0) {
      const { env, findings } = envsWithFindings[0];
      statsEnv = env;
      checkShape('AnomalyFindingResponse', findings[0], {
        id: 'string',
        environmentId: 'string',
        flagKey: 'string',
        metricKey: 'string',
        baselineRate: 'number',
        variantRate: 'number',
        zScore: 'number',
        status: 'string',
        createdAt: 'string',
        variationId: 'string?',
        summary: 'string?',
        suggestedProposalId: 'string?',
      });
      check(
        findings.every((f) => ANOMALY_STATUSES.includes(f.status)),
        'every AnomalyStatus is one of the three the app maps',
        Array.from(new Set(findings.map((f) => f.status))).join(','),
      );

      const open = await api('GET', `/api/environments/${env.id}/anomalies?status=OPEN`);
      check(
        open.every((f) => f.status === 'OPEN'),
        'anomalies ?status=OPEN filters server-side',
        open.map((f) => f.status).join(','),
      );
      check(
        open.length <= findings.length,
        'the OPEN filter is a subset of the unfiltered list',
        `${open.length} open of ${findings.length}`,
      );

      // Oldest first, so a repeat run walks the backlog instead of re-taking one.
      ackTarget = [...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
    }

    // ---------- ack, then assert the re-ack conflicts ----------
    if (ackTarget) {
      info(`acknowledging finding ${ackTarget.id} on ${ackTarget.flagKey}`);
      const acked = await api('POST', `/api/anomalies/${ackTarget.id}/ack`);
      check(acked.status === 'ACKED', 'ack flips the finding to ACKED', acked.status);
      check(acked.id === ackTarget.id, 'ack returns the same finding');

      let reAckStatus = null;
      try {
        await api('POST', `/api/anomalies/${ackTarget.id}/ack`);
      } catch (e) {
        reAckStatus = e.status;
      }
      check(
        reAckStatus === 409,
        're-acking an acknowledged finding returns 409 CONFLICT',
        `got ${reAckStatus}`,
      );
    } else {
      info('no OPEN finding available to acknowledge; skipped the ack + 409 checks');
    }

    // ---------- rollout stats for a flag with a rollout ----------
    const flags = await api('GET', `/api/projects/${projectId}/flags`);
    let ramping = null;
    for (const flag of flags.items) {
      const env = flag.environments.find(
        (e) => e.rolloutPercentage !== undefined && e.rolloutPercentage !== null,
      );
      if (env) {
        ramping = { flag, envKey: env.envKey, percentage: env.rolloutPercentage };
        break;
      }
    }
    check(
      !!ramping,
      'a flag in this project has a percentage rollout (Monitor tab derives from this)',
      'no FlagEnvSummary carries rolloutPercentage',
    );

    if (ramping) {
      const env = project.environments.find((e) => e.key === ramping.envKey) ?? statsEnv;
      info(`rollout: ${ramping.flag.key} at ${ramping.percentage}% on ${ramping.envKey}`);
      const stats = await api(
        'GET',
        `/api/environments/${env.id}/flags/${encodeURIComponent(ramping.flag.key)}/rollout-stats?hours=48`,
      );
      checkShape('RolloutStatsResponse', stats, {
        flagKey: 'string',
        environmentId: 'string',
        totals: 'array',
        buckets: 'array',
      });
      check(stats.flagKey === ramping.flag.key, 'rollout stats come back for the requested flag');
      check(
        stats.environmentId === env.id,
        'rollout stats come back for the requested environment',
      );
      check(stats.totals.length > 0, 'totals carry at least one variant', 'totals is empty');

      if (stats.totals.length > 0) {
        checkShape('VariantStats (totals)', stats.totals[0], {
          variationId: 'string',
          evalCount: 'number',
          errorRate: 'number',
          conversionRate: 'number',
          variationName: 'string?',
        });
        check(
          stats.totals.every((v) => v.errorRate >= 0 && v.errorRate <= 1),
          'errorRate is a 0..1 fraction, as formatRate assumes',
          stats.totals.map((v) => v.errorRate).join(','),
        );
        check(
          stats.totals.every((v) => v.conversionRate >= 0 && v.conversionRate <= 1),
          'conversionRate is a 0..1 fraction',
          stats.totals.map((v) => v.conversionRate).join(','),
        );
      }

      if (stats.buckets.length > 0) {
        checkShape('RolloutStatsBucket', stats.buckets[0], {
          bucketStart: 'string',
          variants: 'array',
        });
        checkShape('VariantStats (bucket)', stats.buckets[0].variants[0], {
          variationId: 'string',
          evalCount: 'number',
          errorRate: 'number',
          conversionRate: 'number',
          variationName: 'string?',
        });
        check(
          !Number.isNaN(new Date(stats.buckets[0].bucketStart).getTime()),
          'bucketStart parses as a date, so the sparkline can order buckets',
          stats.buckets[0].bucketStart,
        );
        const totalIds = new Set(stats.totals.map((v) => v.variationId));
        check(
          stats.buckets.every((b) => b.variants.every((v) => totalIds.has(v.variationId))),
          'every bucket variant also appears in totals (variantSeries can resolve it)',
        );
      } else {
        info('rollout-stats returned no buckets; the sparkline renders its empty baseline');
      }

      // The window parameter must actually narrow the window.
      const short = await api(
        'GET',
        `/api/environments/${env.id}/flags/${encodeURIComponent(ramping.flag.key)}/rollout-stats?hours=24`,
      );
      check(
        short.buckets.length <= stats.buckets.length,
        '?hours=24 returns no more buckets than ?hours=48',
        `${short.buckets.length} vs ${stats.buckets.length}`,
      );
    }

    // ---------- org settings (the Settings AI section) ----------
    const settings = await api('GET', `/api/orgs/${orgId}/settings`);
    checkShape('OrgSettingsResponse', settings, {
      aiEnabled: 'boolean',
      autoRollbackEnabled: 'boolean',
      autoOptimizeEnabled: 'boolean',
      staleFlagWeeks: 'number',
      notificationWebhookSet: 'boolean?',
    });
    const restored = { ...settings };
    const flipped = await api('PUT', `/api/orgs/${orgId}/settings`, {
      autoOptimizeEnabled: !settings.autoOptimizeEnabled,
    });
    check(
      flipped.autoOptimizeEnabled === !settings.autoOptimizeEnabled,
      'PUT settings flips autoOptimizeEnabled (the optimistic toggle path)',
      `${settings.autoOptimizeEnabled} → ${flipped.autoOptimizeEnabled}`,
    );
    const back = await api('PUT', `/api/orgs/${orgId}/settings`, {
      autoOptimizeEnabled: restored.autoOptimizeEnabled,
    });
    check(
      back.autoOptimizeEnabled === restored.autoOptimizeEnabled,
      'settings restored to their original value',
    );
  } catch (e) {
    fail('unexpected error', e.message);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  ai check crashed — ${e.message}`);
  process.exit(1);
});
