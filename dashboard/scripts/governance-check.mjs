#!/usr/bin/env node
/**
 * Live check of the RBAC and change-request surfaces the dashboard drives.
 *
 * It walks the exact sequence the UI walks — read the role catalogue, read my own
 * permissions, grant a scoped role, turn on approval, watch a targeting PUT come back 202
 * instead of writing, fail a self-approval, approve as somebody else, watch it apply — and
 * asserts the parts the UI depends on being true. A backend that changed any of those out
 * from under the dashboard shows up here rather than as a screen that lies to a user.
 *
 * Everything it changes is restored on the way out, in a finally, so it is re-runnable and
 * leaves the seeded environment exactly as it found it.
 *
 *   node scripts/governance-check.mjs
 *   API_BASE=http://host:port node scripts/governance-check.mjs
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
const API_BASE = process.env.API_BASE || 'http://localhost:28080'
const OWNER = process.env.OWNER_EMAIL || 'alice@switchboard.dev'
const REVIEWER = process.env.REVIEWER_EMAIL || 'bob@switchboard.dev'

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

function checkShape(name, value, required) {
  const missing = required.filter((field) => value == null || value[field] === undefined)
  check(
    `${name} shape [${required.join(', ')}]`,
    missing.length === 0,
    `missing: ${missing.join(', ')}`,
  )
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
    /* 204s and error pages */
  }
  if (expect !== null && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect}, got ${res.status}: ${text.slice(0, 300)}`)
  }
  return { status: res.status, body: json, location: res.headers.get('Location') }
}

const sorted = (a) => [...a].sort()

/**
 * The invitation flow the dashboard's Settings → Organization tab drives. Invitations are
 * accepted when the invitee signs in, and a dev token (`Bearer dev:<email>`) is a verified
 * sign-in on the local profile, so "sign in once" here is simply the first request made as
 * that address. Every address is fresh per run.
 */
async function invitations(org, joinedUserIds, pendingInvitationIds) {
  console.log('\ninvitations')
  const run = crypto.randomUUID().slice(0, 8)
  const invitee = `invitee-${run}@governance-check.dev`
  const existing = `existing-${run}@governance-check.dev`
  const revokee = `revokee-${run}@governance-check.dev`
  const base = `/api/orgs/${org.id}/invitations`

  // Someone with no account yet: the invitation waits.
  const invited = (
    await api('POST', base, { body: { email: invitee, role: 'MEMBER' }, expect: 201 })
  ).body
  checkShape('OrgInvitationResponse', invited, [
    'id',
    'email',
    'role',
    'status',
    'invitedBy',
    'createdAt',
  ])
  check('an address with no account is invited PENDING', invited.status === 'PENDING', invited.status)
  pendingInvitationIds.push(invited.id)
  const listed = (await api('GET', base, { expect: 200 })).body
  check('the pending invitation is listed', listed.some((i) => i.id === invited.id))
  const duplicate = await api('POST', base, { body: { email: invitee, role: 'MEMBER' } })
  check('a second pending invitation for the same address is 409', duplicate.status === 409, `got ${duplicate.status}`)

  // First sign-in accepts it.
  const inviteeMe = (await api('GET', '/api/users/me', { as: invitee, expect: 200 })).body
  joinedUserIds.push(inviteeMe.id)
  check(
    'the first sign-in accepts the invitation (membership on /users/me)',
    inviteeMe.memberships.some((m) => m.orgId === org.id && m.role === 'MEMBER'),
    JSON.stringify(inviteeMe.memberships),
  )
  pendingInvitationIds.splice(pendingInvitationIds.indexOf(invited.id), 1)
  const inviteeOrgs = (await api('GET', '/api/orgs', { as: invitee, expect: 200 })).body
  check('the org is in the invitee’s org list', inviteeOrgs.some((o) => o.id === org.id))
  const members = (await api('GET', `/api/orgs/${org.id}/members`, { expect: 200 })).body
  check('the invitee is listed as a member', members.some((m) => m.email === invitee))
  const inviteePerms = (
    await api('GET', `/api/users/me/permissions?orgId=${org.id}`, { as: invitee, expect: 200 })
  ).body
  check(
    'the invitee can read flags straight away (FLAG_READ)',
    inviteePerms.permissions.includes('FLAG_READ'),
    JSON.stringify(inviteePerms.permissions),
  )
  check(
    'a MEMBER invitation does not hand out member management',
    !inviteePerms.permissions.includes('MANAGE_MEMBERS'),
  )
  const afterAccept = (await api('GET', base, { expect: 200 })).body
  check('an accepted invitation leaves the pending list', !afterAccept.some((i) => i.id === invited.id))
  const memberPeek = await api('GET', base, { as: invitee })
  check(
    'listing invitations needs MANAGE_MEMBERS (a MEMBER gets 403)',
    memberPeek.status === 403,
    `got ${memberPeek.status}`,
  )

  // Someone who already has an account: added on the spot.
  const existingMe = (await api('GET', '/api/users/me', { as: existing, expect: 200 })).body
  const direct = (
    await api('POST', base, { body: { email: existing, role: 'MEMBER' }, expect: 201 })
  ).body
  joinedUserIds.push(existingMe.id)
  check('an address that already has an account comes back ACCEPTED', direct.status === 'ACCEPTED', direct.status)
  const membersAfter = (await api('GET', `/api/orgs/${org.id}/members`, { expect: 200 })).body
  check('…and is a member immediately', membersAfter.some((m) => m.email === existing))

  // Revoke: a revoked invitation is never accepted.
  const toRevoke = (
    await api('POST', base, { body: { email: revokee, role: 'MEMBER' }, expect: 201 })
  ).body
  pendingInvitationIds.push(toRevoke.id)
  const revoked = await api('DELETE', `${base}/${toRevoke.id}`)
  check('revokeInvitation returns 204', revoked.status === 204, `got ${revoked.status}`)
  if (revoked.status === 204) pendingInvitationIds.splice(pendingInvitationIds.indexOf(toRevoke.id), 1)
  const afterRevoke = (await api('GET', base, { expect: 200 })).body
  check('a revoked invitation leaves the pending list', !afterRevoke.some((i) => i.id === toRevoke.id))
  const revokeeMe = (await api('GET', '/api/users/me', { as: revokee, expect: 200 })).body
  check(
    'signing in after a revoke does NOT join the org',
    !revokeeMe.memberships.some((m) => m.orgId === org.id),
    JSON.stringify(revokeeMe.memberships),
  )
}

async function main() {
  console.log(`Switchboard governance check → ${API_BASE}\n`)

  // ── Workspace under test ─────────────────────────────────────────────────
  const orgs = (await api('GET', '/api/orgs', { expect: 200 })).body
  const org = orgs[0]
  const projects = (await api('GET', `/api/orgs/${org.id}/projects`, { expect: 200 })).body
  const project = projects[0]
  const envs = (await api('GET', `/api/projects/${project.id}/environments`, { expect: 200 })).body
  const production = envs.find((e) => e.key === 'production')
  const staging = envs.find((e) => e.key === 'staging')
  if (!production || !staging) throw new Error('seed data needs a production and a staging env')
  console.log(`org "${org.name}" → project "${project.key}" → production/staging\n`)

  // ── Role catalogue ───────────────────────────────────────────────────────
  console.log('role catalogue')
  const roles = (await api('GET', '/api/roles', { expect: 200 })).body
  check('listRoles returns items', Array.isArray(roles.items) && roles.items.length > 0)
  checkShape('RoleResponse', roles.items[0], ['key', 'name', 'builtIn', 'permissions'])
  const approver = roles.items.find((r) => r.key === 'APPROVER')
  check('an APPROVER role exists', Boolean(approver))
  check(
    'APPROVER grants APPROVE_CHANGES but not FLAG_WRITE',
    approver?.permissions.includes('APPROVE_CHANGES') && !approver?.permissions.includes('FLAG_WRITE'),
    JSON.stringify(approver?.permissions),
  )
  check(
    'every role permission is one the dashboard humanizes',
    roles.items.every((r) =>
      r.permissions.every((p) =>
        [
          'FLAG_READ',
          'FLAG_WRITE',
          'FLAG_KILL',
          'FLAG_ROLLBACK',
          'SEGMENT_WRITE',
          'APPROVE_CHANGES',
          'MANAGE_MEMBERS',
          'MANAGE_SDK_KEYS',
          'MANAGE_SETTINGS',
          'MANAGE_PROJECTS',
          'MANAGE_ENVIRONMENTS',
          'VIEW_AUDIT',
        ].includes(p),
      ),
    ),
  )

  // ── me/permissions, the call every gated control reads ───────────────────
  console.log('\nme/permissions')
  const mineOrg = (await api('GET', `/api/users/me/permissions?orgId=${org.id}`, { expect: 200 })).body
  checkShape('MyPermissionsResponse', mineOrg, ['scopeType', 'scopeId', 'permissions'])
  check('owner holds MANAGE_MEMBERS at the org', mineOrg.permissions.includes('MANAGE_MEMBERS'))
  const mineProd = (
    await api('GET', `/api/users/me/permissions?envId=${production.id}`, { expect: 200 })
  ).body
  check('asking at an environment answers ENVIRONMENT scope', mineProd.scopeType === 'ENVIRONMENT')
  check(
    'the environment answer unions in the org grant (the dashboard asks only once)',
    mineOrg.permissions.every((p) => mineProd.permissions.includes(p)),
    `org=${mineOrg.permissions.length} env=${mineProd.permissions.length}`,
  )
  const noScope = await api('GET', '/api/users/me/permissions')
  check('naming no scope is rejected rather than guessed at', noScope.status === 400, `got ${noScope.status}`)

  // ── State we must put back ───────────────────────────────────────────────
  const originalSettings = (
    await api('GET', `/api/environments/${production.id}/approval-settings`, { expect: 200 })
  ).body
  checkShape('ApprovalSettingsResponse', originalSettings, [
    'requireApproval',
    'minApprovals',
    'allowSelfApproval',
    'requireApprovalForKill',
  ])
  let grantId = null
  let openedRequestId = null
  // Accounts and invitations the invitation section creates, removed again in the finally.
  const joinedUserIds = []
  const pendingInvitationIds = []

  try {
    // ── A scoped grant applies where it was made, and nowhere else ──────────
    console.log('\nscoped role grant')
    const bobProdBefore = (
      await api('GET', `/api/users/me/permissions?envId=${production.id}`, {
        as: REVIEWER,
        expect: 200,
      })
    ).body
    const bobStagingBefore = (
      await api('GET', `/api/users/me/permissions?envId=${staging.id}`, {
        as: REVIEWER,
        expect: 200,
      })
    ).body
    check(
      'reviewer cannot approve anywhere to begin with',
      !bobProdBefore.permissions.includes('APPROVE_CHANGES') &&
        !bobStagingBefore.permissions.includes('APPROVE_CHANGES'),
    )

    const grant = await api('POST', `/api/orgs/${org.id}/role-assignments`, {
      body: {
        email: REVIEWER,
        roleKey: 'APPROVER',
        scopeType: 'ENVIRONMENT',
        scopeId: production.id,
      },
      expect: 201,
    })
    grantId = grant.body.id
    checkShape('RoleAssignmentResponse', grant.body, [
      'id',
      'userId',
      'userEmail',
      'scopeType',
      'scopeId',
      'roleKey',
      'createdAt',
      'createdBy',
    ])

    const bobProdAfter = (
      await api('GET', `/api/users/me/permissions?envId=${production.id}`, {
        as: REVIEWER,
        expect: 200,
      })
    ).body
    const bobStagingAfter = (
      await api('GET', `/api/users/me/permissions?envId=${staging.id}`, {
        as: REVIEWER,
        expect: 200,
      })
    ).body
    check('the grant reaches production', bobProdAfter.permissions.includes('APPROVE_CHANGES'))
    check(
      'the grant does NOT leak into staging',
      !bobStagingAfter.permissions.includes('APPROVE_CHANGES'),
      JSON.stringify(bobStagingAfter.permissions),
    )
    check(
      'staging is otherwise unchanged — a scoped grant takes nothing away',
      JSON.stringify(sorted(bobStagingBefore.permissions)) ===
        JSON.stringify(sorted(bobStagingAfter.permissions)),
    )

    const assignments = (
      await api('GET', `/api/orgs/${org.id}/role-assignments`, { expect: 200 })
    ).body
    check(
      'the grant is listed for the roles admin screen',
      assignments.items.some((a) => a.id === grantId),
    )

    // ── Invitations: invite → pending → first sign-in → member ─────────────
    await invitations(org, joinedUserIds, pendingInvitationIds)

    // ── Turn approval on for production ────────────────────────────────────
    console.log('\napproval policy')
    const enabled = (
      await api('PUT', `/api/environments/${production.id}/approval-settings`, {
        body: { requireApproval: true, minApprovals: 1, allowSelfApproval: false },
        expect: 200,
      })
    ).body
    check(
      'requireApproval / minApprovals / allowSelfApproval round-trip',
      enabled.requireApproval === true &&
        enabled.minApprovals === 1 &&
        enabled.allowSelfApproval === false,
      JSON.stringify(enabled),
    )
    const envsAfter = (
      await api('GET', `/api/projects/${project.id}/environments`, { expect: 200 })
    ).body
    check(
      'the environment listing carries the policy (the targeting editor reads it there)',
      envsAfter.find((e) => e.id === production.id)?.approvals?.requireApproval === true,
    )

    // ── A gated targeting write answers 202 and writes NOTHING ─────────────
    console.log('\ngated targeting write')
    const flags = (await api('GET', `/api/projects/${project.id}/flags?limit=1`, { expect: 200 })).body
    const flagKey = flags.items[0].key
    const flag = (await api('GET', `/api/projects/${project.id}/flags/${flagKey}`, { expect: 200 }))
      .body
    const before = flag.envConfigs.find((c) => c.envKey === 'production')
    if (!before) throw new Error(`${flagKey} has no production config to edit`)

    const proposed = {
      ...before.config,
      // A change that is unmistakably different from the current config, whatever it is.
      fallthrough: { variationId: before.config.offVariationId },
    }
    const write = await api(
      'PUT',
      `/api/projects/${project.id}/flags/${flagKey}/environments/production`,
      {
        body: {
          enabled: !before.enabled,
          config: proposed,
          expectedVersion: before.version,
          comment: 'governance-check',
        },
      },
    )
    check('the targeting PUT answers 202, not 200', write.status === 202, `got ${write.status}`)
    check('202 carries a Location header pointing at the request', Boolean(write.location), String(write.location))
    checkShape('ChangeRequestResponse', write.body, [
      'id',
      'orgId',
      'projectId',
      'environmentId',
      'envKey',
      'flagId',
      'flagKey',
      'kind',
      'payload',
      'baseVersion',
      'minApprovals',
      'allowSelfApproval',
      'status',
      'requestedBy',
      'requestedByUserId',
      'createdAt',
      'reviews',
      'approvalsMet',
    ])
    openedRequestId = write.body.id
    check('the new request is PENDING', write.body.status === 'PENDING')
    check('it is a TARGETING_UPDATE', write.body.kind === 'TARGETING_UPDATE')
    check('it records the version it was written against', write.body.baseVersion === before.version)

    const afterWrite = (
      await api('GET', `/api/projects/${project.id}/flags/${flagKey}`, { expect: 200 })
    ).body.envConfigs.find((c) => c.envKey === 'production')
    check(
      'THE FLAG IS UNCHANGED — 202 means nothing was written',
      afterWrite.version === before.version && afterWrite.enabled === before.enabled,
      `v${before.version}/${before.enabled} → v${afterWrite.version}/${afterWrite.enabled}`,
    )

    const listed = (
      await api(
        'GET',
        `/api/projects/${project.id}/change-requests?status=PENDING&envKey=production`,
        { expect: 200 },
      )
    ).body
    check(
      'the request shows up in the filtered list the queue page loads',
      listed.items.some((c) => c.id === openedRequestId),
    )

    // ── Self-approval is refused ───────────────────────────────────────────
    console.log('\nreview')
    const selfApprove = await api('POST', `/api/change-requests/${openedRequestId}/approve`, {
      body: { comment: 'approving my own' },
    })
    check(
      "the author's own approval is refused with 403",
      selfApprove.status === 403,
      `got ${selfApprove.status}`,
    )
    const stillPending = (
      await api('GET', `/api/change-requests/${openedRequestId}`, { expect: 200 })
    ).body
    check('the refused self-approval left no review behind', stillPending.reviews.length === 0)

    // ── The reviewer approves, and the threshold applies it ────────────────
    const approved = (
      await api('POST', `/api/change-requests/${openedRequestId}/approve`, {
        as: REVIEWER,
        body: { comment: 'governance-check approval' },
        expect: 200,
      })
    ).body
    check('the reviewer’s approval is accepted', approved.reviews.length === 1)
    check('the request reaches APPLIED once the threshold is met', approved.status === 'APPLIED', approved.status)
    check('it names the version it produced', typeof approved.appliedVersion === 'number')

    const afterApprove = (
      await api('GET', `/api/projects/${project.id}/flags/${flagKey}`, { expect: 200 })
    ).body.envConfigs.find((c) => c.envKey === 'production')
    check(
      'THE FLAG ADVANCED — the approval performed the write',
      afterApprove.version > before.version && afterApprove.enabled === !before.enabled,
      `v${before.version} → v${afterApprove.version}`,
    )
    openedRequestId = null

    // ── A request whose base version was overtaken goes STALE ──────────────
    console.log('\nstale detection')
    const head = afterApprove
    const staleWrite = await api(
      'PUT',
      `/api/projects/${project.id}/flags/${flagKey}/environments/production`,
      {
        body: {
          enabled: head.enabled,
          config: { ...head.config, fallthrough: { variationId: head.config.defaultVariationId } },
          expectedVersion: head.version,
          comment: 'governance-check stale candidate',
        },
        expect: 202,
      },
    )
    const staleId = staleWrite.body.id
    // Move the flag past that base version with a second, independently approved request.
    const overtake = await api(
      'PUT',
      `/api/projects/${project.id}/flags/${flagKey}/environments/production`,
      {
        body: {
          enabled: !head.enabled,
          config: head.config,
          expectedVersion: head.version,
          comment: 'governance-check overtaker',
        },
        expect: 202,
      },
    )
    await api('POST', `/api/change-requests/${overtake.body.id}/approve`, {
      as: REVIEWER,
      expect: 200,
    })

    const staleResult = (
      await api('POST', `/api/change-requests/${staleId}/approve`, { as: REVIEWER, expect: 200 })
    ).body
    check(
      'a request whose base version was overtaken reports STALE',
      staleResult.status === 'STALE',
      staleResult.status,
    )
    const headAfterStale = (
      await api('GET', `/api/projects/${project.id}/flags/${flagKey}`, { expect: 200 })
    ).body.envConfigs.find((c) => c.envKey === 'production')
    check(
      'the stale request did NOT clobber the newer version',
      headAfterStale.enabled === !head.enabled,
    )
  } finally {
    // ── Restore, so the script is re-runnable ──────────────────────────────
    console.log('\ncleanup')
    if (openedRequestId) {
      const w = await api('POST', `/api/change-requests/${openedRequestId}/withdraw`)
      check('withdrew the left-over request', w.status === 200, `got ${w.status}`)
    }
    const restored = await api('PUT', `/api/environments/${production.id}/approval-settings`, {
      body: {
        requireApproval: originalSettings.requireApproval,
        minApprovals: originalSettings.minApprovals,
        allowSelfApproval: originalSettings.allowSelfApproval,
        requireApprovalForKill: originalSettings.requireApprovalForKill,
      },
    })
    check(
      'production approval policy restored',
      restored.status === 200 &&
        restored.body.requireApproval === originalSettings.requireApproval &&
        restored.body.minApprovals === originalSettings.minApprovals,
    )
    // Not asserted: how many of these exist depends on how far the run got, and a pass count
    // that varies with failures would be confusing.
    for (const id of pendingInvitationIds) {
      const res = await api('DELETE', `/api/orgs/${org.id}/invitations/${id}`)
      console.log(`  revoked left-over invitation ${id} (${res.status})`)
    }
    for (const userId of joinedUserIds) {
      const res = await api('DELETE', `/api/orgs/${org.id}/members/${userId}`)
      console.log(`  removed invitation-check member ${userId} (${res.status})`)
    }
    if (grantId) {
      const revoked = await api('DELETE', `/api/orgs/${org.id}/role-assignments/${grantId}`)
      check('reviewer grant revoked', revoked.status === 204, `got ${revoked.status}`)
      const bobAfter = (
        await api('GET', `/api/users/me/permissions?envId=${production.id}`, {
          as: REVIEWER,
          expect: 200,
        })
      ).body
      check(
        'revoking took the permission away again',
        !bobAfter.permissions.includes('APPROVE_CHANGES'),
      )
    }
  }
}

main()
  .then(() => {
    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`)
    if (failures.length > 0) console.log(`failed: ${failures.join(', ')}`)
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(`\nFAIL — ${err.message}`)
    process.exit(1)
  })
