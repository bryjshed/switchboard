#!/usr/bin/env node
/**
 * Live check of the AI, monitoring and audit endpoints — the ones behind the Monitor,
 * Activity, Proposals and Settings→AI screens.
 *
 * It calls them exactly the way `src/lib/{aiApi,monitorApi,auditApi,orgsApi}.ts` do, and
 * asserts the response shapes match `src/types/generated/switchboard-api.d.ts`. A backend
 * that drifts from the spec shows up here rather than as a blank panel in the UI.
 *
 * Uses the local profile's dev token (`Bearer dev:<email>`), which is why this is plain node
 * with no Firebase. Companion to scripts/service-check.mjs, which covers flags and segments.
 *
 *   node scripts/ai-check.mjs                      # against http://localhost:28080
 *   API_BASE=http://host:port node scripts/ai-check.mjs
 *
 * Exits 0 on PASS, 1 on FAIL.
 *
 * WRITES IT MAKES: it acknowledges one OPEN anomaly finding (there is no un-acknowledge, by
 * design) and round-trips one org setting back to its original value. Regenerate findings
 * with:  curl -X POST localhost:28080/api/jobs/rollout-scan -H 'X-Job-Token: local-job-token'
 */
const API_BASE = process.env.API_BASE || 'http://localhost:28080'
const OWNER = process.env.OWNER_EMAIL || 'alice@switchboard.dev'
const JOB_TOKEN = process.env.JOB_TOKEN || 'local-job-token'

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(name, why) {
  console.log(`  SKIP  ${name} — ${why}`)
}

/** Asserts every field the OpenAPI schema marks `required` is actually present. */
function checkShape(name, value, required) {
  const missing = required.filter((field) => value == null || value[field] === undefined)
  check(`${name} shape [${required.join(', ')}]`, missing.length === 0, `missing: ${missing.join(', ')}`)
}

/** Rates cross the wire as 0..1 fractions; the whole monitor UI depends on that. */
function isFraction(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

async function api(method, path, { body, as = OWNER, headers = {}, expect = null } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer dev:${as}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body */
  }
  if (expect !== null && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect}, got ${res.status}: ${text.slice(0, 300)}`)
  }
  return { status: res.status, body: json, text }
}

async function main() {
  console.log(`Switchboard dashboard AI/monitor check → ${API_BASE}\n`)

  const orgs = (await api('GET', '/api/orgs', { expect: 200 })).body
  const org = orgs[0]
  const projects = (await api('GET', `/api/orgs/${org.id}/projects`, { expect: 200 })).body
  const project = projects[0]
  const envs = (await api('GET', `/api/projects/${project.id}/environments`, { expect: 200 })).body
  const prodEnv = envs.find((e) => e.key === 'production') ?? envs[0]
  console.log(`org=${org.name} project=${project.key} env=${prodEnv.key}\n`)

  // ── Proposals: list, filter, get one ─────────────────────────────────────
  console.log('ai proposals: list, status filter, get by id')
  const list = (await api('GET', `/api/projects/${project.id}/ai/proposals?limit=25`, { expect: 200 })).body
  checkShape('AiProposalListResponse', list, ['items'])
  check('proposal list is populated', Array.isArray(list.items) && list.items.length > 0)

  const proposal = list.items[0]
  checkShape('AiProposalResponse', proposal, [
    'id',
    'orgId',
    'projectId',
    'kind',
    'diff',
    'status',
    'createdBy',
    'createdAt',
  ])
  checkShape('FlagChangeDiff', proposal.diff, ['kind', 'flagKey'])
  check(
    'kind is one of the four the UI renders a badge for',
    ['FLAG_CREATE', 'FLAG_UPDATE', 'ROLLBACK', 'RETIREMENT'].includes(proposal.kind),
    proposal.kind,
  )
  check(
    'status is one of the four the filter tabs offer',
    ['DRAFT', 'APPLIED', 'REJECTED', 'EXPIRED'].includes(proposal.status),
    proposal.status,
  )

  const drafts = (
    await api('GET', `/api/projects/${project.id}/ai/proposals?status=DRAFT`, { expect: 200 })
  ).body
  check(
    'status filter returns only that status',
    drafts.items.length > 0 && drafts.items.every((p) => p.status === 'DRAFT'),
  )

  const fetched = (await api('GET', `/api/ai/proposals/${proposal.id}`, { expect: 200 })).body
  check('a proposal can be fetched by id', fetched.id === proposal.id)

  // The system-raised proposals are the ones the UI must label as automatic, and the
  // monitor's diff is the one the DiffPreview has to render as a before/after.
  const systemProposal = list.items.find((p) => p.createdBy === 'switchboard-monitor')
  if (systemProposal) {
    check('a system-raised proposal carries a rationale to show the reviewer', Boolean(systemProposal.rationale))
    const envChange = (systemProposal.diff.envChanges ?? [])[0]
    checkShape('EnvChange', envChange, ['envKey'])
    if (envChange?.config) {
      checkShape('EnvChange.config → FlagTargetingConfig', envChange.config, [
        'offVariationId',
        'defaultVariationId',
        'fallthrough',
      ])
      // The REST diff is resolved against the flag's head, so targeting is UUID-keyed here
      // even though the domain diff names variations by value. DiffPreview resolves both.
      const serve = envChange.config.fallthrough
      const ref = serve.variationId ?? serve.rollout?.[0]?.variationId
      check(
        'a resolved diff references variations by UUID',
        typeof ref === 'string' && /^[0-9a-f-]{36}$/i.test(ref),
        ref,
      )
    }
  } else {
    skip('system-raised proposal shape', 'no switchboard-monitor proposal seeded')
  }

  const retirement = list.items.find((p) => p.kind === 'RETIREMENT')
  if (retirement) {
    check(
      'a retirement proposal carries its checklist',
      Array.isArray(retirement.diff.retirementChecklist) &&
        retirement.diff.retirementChecklist.length > 0,
    )
  } else {
    skip('retirement checklist', 'no RETIREMENT proposal seeded')
  }

  // ── Drafting: 503 here, 400 for a bad request ────────────────────────────
  console.log('\nai draft: AI_UNAVAILABLE and validation')
  const drafted = await api('POST', `/api/projects/${project.id}/ai/proposals`, {
    body: { prompt: 'turn dark-mode fully on in dev', environmentKey: 'dev' },
  })
  check(
    'drafting returns 503 in an environment with no model provider',
    drafted.status === 503,
    `got ${drafted.status}`,
  )
  checkShape('503 body → ApiError', drafted.body, ['error', 'message'])
  check(
    '503 body carries error=AI_UNAVAILABLE, which the dialog keys its calm state off',
    drafted.body?.error === 'AI_UNAVAILABLE',
    drafted.body?.error,
  )

  const invalid = await api('POST', `/api/projects/${project.id}/ai/proposals`, { body: { prompt: '' } })
  check(
    'an invalid prompt is a 400, distinguishable from AI being unavailable',
    invalid.status === 400 && invalid.body?.error !== 'AI_UNAVAILABLE',
    `got ${invalid.status} ${invalid.body?.error}`,
  )

  // ── Anomalies: list, status filter, ack, re-ack 409 ──────────────────────
  console.log('\nanomalies: list, filter, ack, re-ack 409')
  let findings = (await api('GET', `/api/environments/${prodEnv.id}/anomalies`, { expect: 200 })).body
  check('listAnomalies returns an array', Array.isArray(findings))

  if (findings.length === 0) {
    console.log('  (no findings; running the rollout scan to generate some)')
    await api('POST', '/api/jobs/rollout-scan', { headers: { 'X-Job-Token': JOB_TOKEN } })
    findings = (await api('GET', `/api/environments/${prodEnv.id}/anomalies`, { expect: 200 })).body
  }

  if (findings.length === 0) {
    skip('anomaly shape and ack flow', 'no findings in this environment')
  } else {
    checkShape('AnomalyFindingResponse', findings[0], [
      'id',
      'environmentId',
      'flagKey',
      'metricKey',
      'baselineRate',
      'variantRate',
      'zScore',
      'status',
      'createdAt',
    ])
    check(
      'anomaly rates are 0..1 fractions, not percentages',
      isFraction(findings[0].baselineRate) && isFraction(findings[0].variantRate),
      `baseline=${findings[0].baselineRate} variant=${findings[0].variantRate}`,
    )
    check(
      'anomaly status is one the UI has a treatment for',
      findings.every((f) => ['OPEN', 'ACKED', 'AUTO_ROLLED_BACK'].includes(f.status)),
    )

    const open = (
      await api(`GET`, `/api/environments/${prodEnv.id}/anomalies?status=OPEN`, { expect: 200 })
    ).body
    check('status filter returns only OPEN findings', open.every((f) => f.status === 'OPEN'))

    // Acknowledging is one-way, so a repeat run of this script finds nothing OPEN. The 409
    // contract still gets proven against an already-acknowledged finding, because that is
    // the case the UI's ConflictError branch actually exists for.
    let settledId = null
    if (open.length > 0) {
      const target = open[0]
      const acked = (await api('POST', `/api/anomalies/${target.id}/ack`, { expect: 200 })).body
      check('ack flips the finding to ACKED', acked.status === 'ACKED', acked.status)
      settledId = target.id
    } else {
      skip('ack an OPEN finding', 'nothing OPEN — a previous run acknowledged it')
      settledId = findings.find((f) => f.status !== 'OPEN')?.id ?? null
    }

    if (settledId) {
      const again = await api('POST', `/api/anomalies/${settledId}/ack`)
      check(
        'acknowledging a finding that is no longer OPEN is a 409',
        again.status === 409,
        `got ${again.status}`,
      )
      checkShape('re-ack 409 → ApiError', again.body, ['error', 'message'])
      check('409 body carries error=CONFLICT', again.body?.error === 'CONFLICT', again.body?.error)
    } else {
      skip('409 on re-ack', 'no settled finding to re-acknowledge')
    }
  }

  // ── Apply is guarded ─────────────────────────────────────────────────────
  const settled = list.items.find((p) => p.status !== 'DRAFT')
  if (settled) {
    const reapply = await api('POST', `/api/ai/proposals/${settled.id}/apply`, { body: {} })
    check(
      'applying a proposal that already left DRAFT is a 409',
      reapply.status === 409,
      `got ${reapply.status}`,
    )
  } else {
    // Not applied here on purpose: applying would rewrite a seeded flag's targeting.
    skip('apply 409 on a non-DRAFT proposal', 'every seeded proposal is still DRAFT')
  }

  // ── Rollout stats ────────────────────────────────────────────────────────
  console.log('\nrollout stats: totals, buckets, rate ranges')
  const flags = (await api('GET', `/api/projects/${project.id}/flags`, { expect: 200 })).body
  const rolloutFlag = flags.items.find((flag) =>
    flag.environments.some((e) => e.envKey === prodEnv.key && e.rolloutPercentage != null),
  )
  check(
    'at least one flag in this environment is serving a rollout',
    Boolean(rolloutFlag),
    'the Monitor active-rollouts table would be empty',
  )

  if (rolloutFlag) {
    const stats = (
      await api(
        'GET',
        `/api/environments/${prodEnv.id}/flags/${rolloutFlag.key}/rollout-stats?hours=48`,
        { expect: 200 },
      )
    ).body
    checkShape('RolloutStatsResponse', stats, ['flagKey', 'environmentId', 'totals', 'buckets'])
    check('totals is an array', Array.isArray(stats.totals))
    check('buckets is an array', Array.isArray(stats.buckets))
    check(`${rolloutFlag.key} has per-variant totals`, stats.totals.length > 0)

    if (stats.totals.length > 0) {
      checkShape('VariantStats', stats.totals[0], [
        'variationId',
        'evalCount',
        'errorRate',
        'conversionRate',
      ])
      check(
        'every total rate is a 0..1 fraction',
        stats.totals.every((v) => isFraction(v.errorRate) && isFraction(v.conversionRate)),
        JSON.stringify(stats.totals.map((v) => [v.errorRate, v.conversionRate])),
      )
      check(
        'eval counts are non-negative integers',
        stats.totals.every((v) => Number.isInteger(v.evalCount) && v.evalCount >= 0),
      )
      check(
        'variants carry a display name for the comparison table',
        stats.totals.every((v) => typeof v.variationName === 'string'),
      )
    }

    if (stats.buckets.length > 0) {
      checkShape('RolloutStatsBucket', stats.buckets[0], ['bucketStart', 'variants'])
      check(
        'bucketStart parses as a timestamp',
        !Number.isNaN(new Date(stats.buckets[0].bucketStart).getTime()),
        stats.buckets[0].bucketStart,
      )
      check(
        'every bucketed rate is a 0..1 fraction',
        stats.buckets.every((b) =>
          b.variants.every((v) => isFraction(v.errorRate) && isFraction(v.conversionRate)),
        ),
      )
      const bucketTotal = stats.buckets.reduce(
        (sum, b) => sum + b.variants.reduce((s, v) => s + v.evalCount, 0),
        0,
      )
      const grandTotal = stats.totals.reduce((s, v) => s + v.evalCount, 0)
      check(
        'bucketed evaluations add up to the totals',
        bucketTotal === grandTotal,
        `buckets=${bucketTotal} totals=${grandTotal}`,
      )
    }

    const shortWindow = (
      await api(
        'GET',
        `/api/environments/${prodEnv.id}/flags/${rolloutFlag.key}/rollout-stats?hours=24`,
        { expect: 200 },
      )
    ).body
    check(
      'a shorter window returns no more buckets than a longer one',
      shortWindow.buckets.length <= stats.buckets.length,
      `24h=${shortWindow.buckets.length} 48h=${stats.buckets.length}`,
    )
  }

  // ── Audit ────────────────────────────────────────────────────────────────
  console.log('\naudit: org feed, project filters, keyset paging')
  const orgAudit = (await api('GET', `/api/orgs/${org.id}/audit?limit=5`, { expect: 200 })).body
  checkShape('AuditListResponse', orgAudit, ['items'])
  check('org audit is populated', orgAudit.items.length > 0)
  checkShape('AuditEntryResponse', orgAudit.items[0], ['id', 'orgId', 'action', 'actor', 'createdAt'])
  check(
    'audit is newest first',
    orgAudit.items.every(
      (item, i) => i === 0 || new Date(orgAudit.items[i - 1].createdAt) >= new Date(item.createdAt),
    ),
  )

  if (orgAudit.nextCursor) {
    const page2 = (
      await api('GET', `/api/orgs/${org.id}/audit?limit=5&cursor=${encodeURIComponent(orgAudit.nextCursor)}`, {
        expect: 200,
      })
    ).body
    const firstIds = new Set(orgAudit.items.map((i) => i.id))
    check(
      'the next cursor returns a page with no overlap',
      page2.items.length > 0 && page2.items.every((i) => !firstIds.has(i.id)),
    )
  } else {
    skip('keyset paging', 'the first page held everything')
  }

  const projectAudit = (
    await api('GET', `/api/projects/${project.id}/audit?env=${prodEnv.key}&limit=10`, { expect: 200 })
  ).body
  check(
    'the env filter returns only that environment (or org-level entries)',
    projectAudit.items.every((i) => i.envKey === undefined || i.envKey === prodEnv.key),
  )

  const flagKey = orgAudit.items.find((i) => i.flagKey)?.flagKey
  if (flagKey) {
    const flagAudit = (
      await api('GET', `/api/projects/${project.id}/audit?flagKey=${encodeURIComponent(flagKey)}`, {
        expect: 200,
      })
    ).body
    check(
      `the flagKey filter (${flagKey}) returns only that flag`,
      flagAudit.items.length > 0 && flagAudit.items.every((i) => i.flagKey === flagKey),
    )
  } else {
    skip('flagKey filter', 'no audit entry names a flag')
  }

  // ── Org settings round-trip ──────────────────────────────────────────────
  console.log('\norg settings: read, PUT round-trip, partial merge')
  const before = (await api('GET', `/api/orgs/${org.id}/settings`, { expect: 200 })).body
  checkShape('OrgSettingsResponse', before, [
    'aiEnabled',
    'autoRollbackEnabled',
    'autoOptimizeEnabled',
    'staleFlagWeeks',
  ])
  check(
    'the AI toggles are booleans the switches can bind to',
    typeof before.aiEnabled === 'boolean' &&
      typeof before.autoRollbackEnabled === 'boolean' &&
      typeof before.autoOptimizeEnabled === 'boolean',
  )
  check('notificationWebhookSet is reported', typeof before.notificationWebhookSet === 'boolean')

  const probeWeeks = before.staleFlagWeeks === 9 ? 8 : 9
  const written = (
    await api('PUT', `/api/orgs/${org.id}/settings`, {
      expect: 200,
      body: { staleFlagWeeks: probeWeeks },
    })
  ).body
  check('PUT applies the new value', written.staleFlagWeeks === probeWeeks, `${written.staleFlagWeeks}`)
  // The AI tab sends one field per toggle, so a partial PUT must not reset the others.
  check(
    'a partial PUT leaves the untouched toggles alone',
    written.aiEnabled === before.aiEnabled &&
      written.autoRollbackEnabled === before.autoRollbackEnabled &&
      written.autoOptimizeEnabled === before.autoOptimizeEnabled,
  )

  const restored = (
    await api('PUT', `/api/orgs/${org.id}/settings`, {
      expect: 200,
      body: { staleFlagWeeks: before.staleFlagWeeks },
    })
  ).body
  check('the round-trip restores the original value', restored.staleFlagWeeks === before.staleFlagWeeks)

  const rejected = await api('PUT', `/api/orgs/${org.id}/settings`, { body: { staleFlagWeeks: 0 } })
  check(
    'an out-of-range stale window is rejected, which is why the input clamps',
    rejected.status === 400,
    `got ${rejected.status}`,
  )

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
  if (failed > 0) console.log(`failed checks:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\nFAIL  ai check aborted: ${err.message}`)
  process.exit(1)
})
