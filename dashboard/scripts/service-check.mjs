#!/usr/bin/env node
/**
 * Live check against a running backend. Exercises every endpoint the dashboard's api modules
 * call and asserts the response shapes match what `src/types/generated/switchboard-api.d.ts`
 * describes — a spec/backend drift that would break a page shows up here instead of in the UI.
 *
 * Uses the local profile's dev token (`Bearer dev:<email>`), which is why this is plain node
 * with no Firebase. The dashboard itself always uses real Firebase emulator tokens.
 *
 *   node scripts/service-check.mjs                 # against http://localhost:28080
 *   API_BASE=http://host:port node scripts/service-check.mjs
 *
 * Exits 0 on PASS, 1 on FAIL. Everything it creates is cleaned up on the way out.
 */
const API_BASE = process.env.API_BASE || 'http://localhost:28080'
const OWNER = process.env.OWNER_EMAIL || 'alice@switchboard.dev'
const OUTSIDER = process.env.OUTSIDER_EMAIL || 'carol@beta.dev'

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

/** Asserts every field the OpenAPI schema marks `required` is actually present. */
function checkShape(name, value, required) {
  const missing = required.filter((field) => value == null || value[field] === undefined)
  check(`${name} shape [${required.join(', ')}]`, missing.length === 0, `missing: ${missing.join(', ')}`)
}

async function api(method, path, { body, as = OWNER, expect = null } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer dev:${as}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body (204s, error pages) */
  }
  if (expect !== null && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect}, got ${res.status}: ${text.slice(0, 300)}`)
  }
  return { status: res.status, body: json, text }
}

const uuid = () => crypto.randomUUID()

async function main() {
  console.log(`Switchboard dashboard service check → ${API_BASE}\n`)

  // ── Auth / workspace ─────────────────────────────────────────────────────
  console.log('users, orgs, projects, environments')
  const me = (await api('GET', '/api/users/me', { expect: 200 })).body
  checkShape('UserResponse', me, ['id', 'email', 'onboardingCompleted', 'memberships'])
  check('memberships is an array', Array.isArray(me.memberships))

  const orgs = (await api('GET', '/api/orgs', { expect: 200 })).body
  check('listOrgs returns an array', Array.isArray(orgs) && orgs.length > 0)
  const org = orgs[0]
  checkShape('OrgResponse', org, ['id', 'name', 'slug', 'role', 'createdAt'])

  const members = (await api('GET', `/api/orgs/${org.id}/members`, { expect: 200 })).body
  check('listOrgMembers returns an array', Array.isArray(members) && members.length > 0)
  checkShape('OrgMemberResponse', members[0], ['userId', 'email', 'role', 'joinedAt'])

  const settings = (await api('GET', `/api/orgs/${org.id}/settings`, { expect: 200 })).body
  checkShape('OrgSettingsResponse', settings, [
    'aiEnabled',
    'autoRollbackEnabled',
    'autoOptimizeEnabled',
    'staleFlagWeeks',
  ])

  const projects = (await api('GET', `/api/orgs/${org.id}/projects`, { expect: 200 })).body
  check('listProjects returns an array', Array.isArray(projects) && projects.length > 0)
  const project = projects[0]
  checkShape('ProjectResponse', project, ['id', 'orgId', 'key', 'name', 'environments'])

  const envs = (await api('GET', `/api/projects/${project.id}/environments`, { expect: 200 })).body
  check('listEnvironments returns an array', Array.isArray(envs) && envs.length >= 3)
  checkShape('EnvironmentResponse', envs[0], ['id', 'projectId', 'key', 'name', 'stateVersion'])
  const devEnv = envs.find((e) => e.key === 'dev') ?? envs[0]

  // ── Org isolation ────────────────────────────────────────────────────────
  const outsider = await api('GET', `/api/projects/${project.id}/flags`, { as: OUTSIDER })
  check(
    `a member of another org cannot read this project's flags (got ${outsider.status})`,
    outsider.status === 403 || outsider.status === 404,
  )

  // ── Flags list / detail ──────────────────────────────────────────────────
  console.log('\nflags: list, filter, detail')
  const list = (await api('GET', `/api/projects/${project.id}/flags`, { expect: 200 })).body
  checkShape('FlagListResponse', list, ['items'])
  check('flag list is populated', list.items.length > 0)
  const summary = list.items[0]
  checkShape('FlagSummaryResponse', summary, ['id', 'key', 'name', 'kind', 'tags', 'environments'])
  checkShape('FlagEnvSummary', summary.environments[0], [
    'envKey',
    'enabled',
    'killSwitchActive',
    'version',
  ])

  const searched = (await api('GET', `/api/projects/${project.id}/flags?query=checkout`, { expect: 200 })).body
  check(
    'query filter narrows the list',
    searched.items.length > 0 && searched.items.every((f) => /checkout/i.test(`${f.key} ${f.name}`)),
  )

  const anyTag = list.items.flatMap((f) => f.tags)[0]
  if (anyTag) {
    const tagged = (
      await api('GET', `/api/projects/${project.id}/flags?tag=${encodeURIComponent(anyTag)}`, { expect: 200 })
    ).body
    check(
      `tag filter (${anyTag}) returns only tagged flags`,
      tagged.items.length > 0 && tagged.items.every((f) => f.tags.includes(anyTag)),
    )
  }

  const seeded = (await api('GET', `/api/projects/${project.id}/flags/new-checkout`, { expect: 200 })).body
  checkShape('FlagDetailResponse', seeded, [
    'id',
    'projectId',
    'key',
    'name',
    'kind',
    'variations',
    'tags',
    'envConfigs',
  ])
  checkShape('Variation', seeded.variations[0], ['id', 'value'])
  const seededProd = seeded.envConfigs.find((c) => c.envKey === 'production')
  checkShape('FlagEnvConfigResponse', seededProd, [
    'flagId',
    'environmentId',
    'envKey',
    'enabled',
    'killSwitchActive',
    'config',
    'version',
    'updatedAt',
    'updatedBy',
  ])
  checkShape('FlagTargetingConfig', seededProd.config, [
    'offVariationId',
    'defaultVariationId',
    'fallthrough',
  ])

  // ── Throwaway flag: create → target → conflict → kill → rollback ─────────
  console.log('\nflags: create, targeting PUT, stale-version 409, kill switch, rollback')
  const flagKey = `dash-check-${Date.now()}`
  let createdFlag
  let createdSegmentKey
  try {
    createdFlag = (
      await api('POST', `/api/projects/${project.id}/flags`, {
        expect: 201,
        body: {
          key: flagKey,
          name: 'Dashboard service check',
          description: 'Created by scripts/service-check.mjs',
          kind: 'STRING',
          tags: ['service-check'],
          variations: [
            { value: 'control', name: 'Control' },
            { value: 'variant', name: 'Variant' },
          ],
        },
      })
    ).body
    checkShape('createFlag → FlagDetailResponse', createdFlag, [
      'id',
      'projectId',
      'key',
      'name',
      'kind',
      'variations',
      'tags',
      'envConfigs',
    ])
    check('created flag has a config per environment', createdFlag.envConfigs.length === envs.length)
    check('created flag has both variations', createdFlag.variations.length === 2)

    const [control, variant] = createdFlag.variations
    const devConfig = createdFlag.envConfigs.find((c) => c.envKey === 'dev')
    const baseVersion = devConfig.version

    // A full targeting write: rule with a rollout serve + individual target + fallthrough ramp.
    const targeting = {
      enabled: true,
      expectedVersion: baseVersion,
      comment: 'service-check: 25% ramp',
      config: {
        individualTargets: [{ contextKey: 'service-check-user', variationId: variant.id }],
        rules: [
          {
            id: uuid(), // the backend parses rule ids as UUIDs
            description: 'pro plan gets a split',
            clauses: [{ attribute: 'plan', op: 'IN', values: ['pro', 'enterprise'] }],
            serve: {
              rollout: [
                { variationId: control.id, weight: 50 },
                { variationId: variant.id, weight: 50 },
              ],
            },
          },
        ],
        fallthrough: {
          rollout: [
            { variationId: control.id, weight: 75 },
            { variationId: variant.id, weight: 25 },
          ],
        },
        offVariationId: control.id,
        defaultVariationId: control.id,
      },
    }

    const saved = (
      await api('PUT', `/api/projects/${project.id}/flags/${flagKey}/environments/dev`, {
        expect: 200,
        body: targeting,
      })
    ).body
    checkShape('updateFlagEnvConfig → FlagEnvConfigResponse', saved, [
      'flagId',
      'environmentId',
      'envKey',
      'enabled',
      'killSwitchActive',
      'config',
      'version',
      'updatedAt',
      'updatedBy',
    ])
    check('a write bumps the version', saved.version === baseVersion + 1)
    check('rules round-trip', saved.config.rules?.length === 1)
    check('individual targets round-trip', saved.config.individualTargets?.length === 1)
    check(
      'fallthrough rollout round-trips with its weights',
      saved.config.fallthrough?.rollout?.reduce((t, w) => t + w.weight, 0) === 100,
    )

    // The 409 path the targeting editor's conflict banner is built for.
    const stale = await api('PUT', `/api/projects/${project.id}/flags/${flagKey}/environments/dev`, {
      body: { ...targeting, expectedVersion: baseVersion },
    })
    check('a stale expectedVersion is rejected with 409', stale.status === 409, `got ${stale.status}`)
    checkShape('409 body → ApiError', stale.body, ['error', 'message'])
    check(
      '409 body carries error=CONFLICT',
      stale.body?.error === 'CONFLICT',
      `got ${stale.body?.error}`,
    )

    // Kill switch: on, then off. Never version-conflicts.
    const killed = (
      await api('POST', `/api/projects/${project.id}/flags/${flagKey}/environments/dev/kill-switch`, {
        expect: 200,
        body: { active: true, reason: 'service-check' },
      })
    ).body
    check('kill switch on sets killSwitchActive', killed.killSwitchActive === true)
    check('kill switch on bumps the version', killed.version === saved.version + 1)

    const unkilled = (
      await api('POST', `/api/projects/${project.id}/flags/${flagKey}/environments/dev/kill-switch`, {
        expect: 200,
        body: { active: false, reason: 'service-check clear' },
      })
    ).body
    check('kill switch off clears killSwitchActive', unkilled.killSwitchActive === false)
    check('targeting survived the kill switch', unkilled.config.rules?.length === 1)

    // Version history + rollback.
    const versions = (
      await api('GET', `/api/projects/${project.id}/flags/${flagKey}/environments/dev/versions`, {
        expect: 200,
      })
    ).body
    checkShape('FlagVersionListResponse', versions, ['items'])
    check('history has every version written', versions.items.length >= 4)
    checkShape('FlagVersionResponse', versions.items[0], [
      'versionNumber',
      'enabled',
      'killSwitchActive',
      'config',
      'createdBy',
      'createdAt',
    ])
    check(
      'history is newest first',
      versions.items[0].versionNumber > versions.items[versions.items.length - 1].versionNumber,
    )

    const one = (
      await api('GET', `/api/projects/${project.id}/flags/${flagKey}/environments/dev/versions/1`, {
        expect: 200,
      })
    ).body
    check('a single version can be fetched by number', one.versionNumber === 1)

    const rolledBack = (
      await api('POST', `/api/projects/${project.id}/flags/${flagKey}/environments/dev/rollback`, {
        expect: 200,
        body: { toVersion: 1, reason: 'service-check rollback' },
      })
    ).body
    check(
      'rollback writes a NEW version rather than rewriting history',
      rolledBack.version === unkilled.version + 1,
    )
    check(
      'rollback restores the v1 targeting',
      (rolledBack.config.rules ?? []).length === 0,
      `rules=${JSON.stringify(rolledBack.config.rules)}`,
    )

    // PATCH details + add variations.
    console.log('\nflags: PATCH details, add variations')
    const patched = (
      await api('PATCH', `/api/projects/${project.id}/flags/${flagKey}`, {
        expect: 200,
        body: { name: 'Dashboard service check (renamed)', tags: ['service-check', 'renamed'] },
      })
    ).body
    check('PATCH renames the flag', patched.name === 'Dashboard service check (renamed)')
    check('PATCH replaces the tags', patched.tags.includes('renamed'))

    const withVariation = (
      await api('PATCH', `/api/projects/${project.id}/flags/${flagKey}`, {
        expect: 200,
        body: { addVariations: [{ value: 'variant-b', name: 'Variant B' }] },
      })
    ).body
    check('addVariations appends a variation', withVariation.variations.length === 3)

    // ── Segments CRUD, including the referenced-segment 409 ────────────────
    console.log('\nsegments: create, get, update, list, referenced delete 409, delete')
    createdSegmentKey = `dash-check-seg-${Date.now()}`
    const segment = (
      await api('POST', `/api/projects/${project.id}/segments`, {
        expect: 201,
        body: {
          key: createdSegmentKey,
          name: 'Service check segment',
          includedKeys: ['user-1', 'user-2'],
          excludedKeys: ['user-3'],
          rules: [{ clauses: [{ attribute: 'plan', op: 'EQUALS', values: ['pro'] }] }],
        },
      })
    ).body
    checkShape('SegmentResponse', segment, [
      'id',
      'projectId',
      'key',
      'name',
      'includedKeys',
      'excludedKeys',
      'rules',
    ])
    check('segment included keys round-trip', segment.includedKeys.length === 2)

    const fetchedSegment = (
      await api('GET', `/api/projects/${project.id}/segments/${createdSegmentKey}`, { expect: 200 })
    ).body
    check('segment can be fetched by key', fetchedSegment.key === createdSegmentKey)

    const updatedSegment = (
      await api('PUT', `/api/projects/${project.id}/segments/${createdSegmentKey}`, {
        expect: 200,
        body: {
          key: createdSegmentKey,
          name: 'Service check segment (updated)',
          includedKeys: ['user-1'],
          excludedKeys: [],
          rules: [],
        },
      })
    ).body
    check('segment update applies', updatedSegment.name === 'Service check segment (updated)')
    check('segment update clears removed keys', updatedSegment.includedKeys.length === 1)

    const segmentList = (await api('GET', `/api/projects/${project.id}/segments`, { expect: 200 })).body
    check(
      'segment appears in the list',
      Array.isArray(segmentList) && segmentList.some((s) => s.key === createdSegmentKey),
    )

    // Point a flag rule at the segment, then confirm delete is refused with 409.
    const current = (await api('GET', `/api/projects/${project.id}/flags/${flagKey}`, { expect: 200 })).body
    const currentDev = current.envConfigs.find((c) => c.envKey === 'dev')
    await api('PUT', `/api/projects/${project.id}/flags/${flagKey}/environments/dev`, {
      expect: 200,
      body: {
        enabled: true,
        expectedVersion: currentDev.version,
        comment: 'service-check: reference the segment',
        config: {
          ...currentDev.config,
          rules: [
            {
              id: uuid(),
              clauses: [{ attribute: 'segment', op: 'SEGMENT_MATCH', values: [createdSegmentKey] }],
              serve: { variationId: current.variations[1].id },
            },
          ],
        },
      },
    })
    const refusedDelete = await api('DELETE', `/api/projects/${project.id}/segments/${createdSegmentKey}`)
    check(
      'deleting a referenced segment is refused with 409',
      refusedDelete.status === 409,
      `got ${refusedDelete.status}`,
    )
    checkShape('referenced-delete 409 → ApiError', refusedDelete.body, ['error', 'message'])
    // The message is generic (it does not name the referencing flags), which is why the
    // SegmentsPage dialog renders it verbatim rather than promising specifics.
    check(
      '409 explains why the delete was refused',
      refusedDelete.body?.error === 'CONFLICT' &&
        /referenc/i.test(refusedDelete.body?.message ?? ''),
      refusedDelete.body?.message,
    )

    // Drop the reference, then the delete must succeed.
    const beforeDrop = (await api('GET', `/api/projects/${project.id}/flags/${flagKey}`, { expect: 200 })).body
    const devBeforeDrop = beforeDrop.envConfigs.find((c) => c.envKey === 'dev')
    await api('PUT', `/api/projects/${project.id}/flags/${flagKey}/environments/dev`, {
      expect: 200,
      body: {
        enabled: true,
        expectedVersion: devBeforeDrop.version,
        comment: 'service-check: drop the segment reference',
        config: { ...devBeforeDrop.config, rules: [] },
      },
    })
    const deleted = await api('DELETE', `/api/projects/${project.id}/segments/${createdSegmentKey}`)
    check('unreferenced segment deletes with 204', deleted.status === 204, `got ${deleted.status}`)
    createdSegmentKey = null

    // ── SDK keys ───────────────────────────────────────────────────────────
    console.log('\nsdk keys: list, create (one-time reveal), revoke')
    const keysBefore = (await api('GET', `/api/environments/${devEnv.id}/sdk-keys`, { expect: 200 })).body
    check('listSdkKeys returns an array', Array.isArray(keysBefore))

    const createdKey = (
      await api('POST', `/api/environments/${devEnv.id}/sdk-keys`, {
        expect: 201,
        body: { label: 'service-check' },
      })
    ).body
    checkShape('SdkKeyCreatedResponse', createdKey, [
      'id',
      'environmentId',
      'key',
      'keyPrefix',
      'createdAt',
    ])
    check('the full key is returned exactly once, at creation', typeof createdKey.key === 'string')
    // keyPrefix is display-ready: it already carries a trailing ellipsis, so the UI renders
    // it verbatim rather than appending its own.
    check(
      'keyPrefix is a display-truncated prefix of the full key',
      createdKey.keyPrefix.endsWith('…') &&
        createdKey.key.startsWith(createdKey.keyPrefix.slice(0, -1)),
      `key=${createdKey.key} prefix=${createdKey.keyPrefix}`,
    )

    const keysAfter = (await api('GET', `/api/environments/${devEnv.id}/sdk-keys`, { expect: 200 })).body
    const listed = keysAfter.find((k) => k.id === createdKey.id)
    checkShape('SdkKeyResponse', listed, ['id', 'environmentId', 'keyPrefix', 'createdAt'])
    check('the list never returns the full key', listed.key === undefined)

    const revoked = await api('DELETE', `/api/sdk-keys/${createdKey.id}`)
    check('revoke returns 204', revoked.status === 204, `got ${revoked.status}`)
    const keysFinal = (await api('GET', `/api/environments/${devEnv.id}/sdk-keys`, { expect: 200 })).body
    const revokedRow = keysFinal.find((k) => k.id === createdKey.id)
    check('a revoked key is marked revokedAt (or gone)', !revokedRow || Boolean(revokedRow.revokedAt))
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────────────
    console.log('\ncleanup')
    if (createdSegmentKey) {
      const res = await api('DELETE', `/api/projects/${project.id}/segments/${createdSegmentKey}`)
      console.log(`  removed segment ${createdSegmentKey} (${res.status})`)
    }
    if (createdFlag) {
      const res = await api('DELETE', `/api/projects/${project.id}/flags/${flagKey}`)
      check('archiveFlag returns 204', res.status === 204, `got ${res.status}`)
      const listAfter = (await api('GET', `/api/projects/${project.id}/flags`, { expect: 200 })).body
      check('an archived flag drops out of the listing', !listAfter.items.some((f) => f.key === flagKey))
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
  if (failed > 0) console.log(`failed checks:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\nFAIL  service check aborted: ${err.message}`)
  process.exit(1)
})
