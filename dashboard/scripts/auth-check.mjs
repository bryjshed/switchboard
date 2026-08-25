#!/usr/bin/env node
/**
 * Live check of the dashboard's auth seam, both implementations, against a running backend.
 *
 * `service-check.mjs` and its siblings use the local profile's `Bearer dev:<email>` shortcut and
 * therefore prove nothing about authentication. This one proves the part they skip: that a token
 * minted by a real identity provider, carried by the dashboard's own provider implementation and
 * its own `apiClient`, is accepted by Switchboard.
 *
 * Both legs run the code that ships. `bundle-auth.mjs` compiles `src/auth` and `src/lib/apiClient`
 * for node with `VITE_AUTH_PROVIDER` baked in exactly as a browser build would, so the
 * provider-selection branch exercised here is the one in `dist`.
 *
 *   node scripts/auth-check.mjs              # both legs
 *   node scripts/auth-check.mjs --only=firebase
 *   node scripts/auth-check.mjs --only=oidc
 *
 * What each leg does NOT cover:
 *   firebase — nothing. Sign-in is a REST call the SDK makes either way.
 *   oidc     — the browser redirect itself (authorize -> IdP login page -> code -> callback).
 *              A redirect cannot be driven headlessly. Everything downstream of the code
 *              exchange is real: real signed token, real UserManager storage, real getIdToken,
 *              real apiClient. See README "What stays manual".
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
import { startOidcIssuer } from './lib/oidc-issuer.mjs'
import { bundleAuth } from './lib/bundle-auth.mjs'

const API_BASE = process.env.API_BASE || 'http://localhost:28080'
const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR || 'http://localhost:29099'
const EMAIL = process.env.LOGIN_EMAIL || 'alice@switchboard.dev'
const PASSWORD = process.env.LOGIN_PASSWORD || 'password123'
const OIDC_PORT = Number(process.env.OIDC_PORT || 29199)
const OIDC_AUDIENCE = process.env.OIDC_AUDIENCE || 'switchboard-dashboard'
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || 'switchboard-dashboard'

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? 'both'

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

function section(title) {
  console.log(`\n${title}`)
}

async function firebaseLeg() {
  section('Firebase provider (emulator on ' + EMULATOR + ')')

  const auth = await bundleAuth({
    VITE_AUTH_PROVIDER: 'firebase',
    VITE_API_BASE_URL: API_BASE,
    VITE_FIREBASE_AUTH_EMULATOR_HOST: EMULATOR,
    VITE_FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'demo-switchboard',
    VITE_FIREBASE_API_KEY: 'demo-api-key',
    VITE_FIREBASE_AUTH_DOMAIN: 'demo-switchboard.firebaseapp.com',
    VITE_FIREBASE_APP_ID: 'demo-app-id',
  })

  const config = auth.readAuthConfig()
  check('config selects the firebase provider', config.kind === 'firebase', `got ${config.kind}`)

  const provider = await auth.initAuth()
  check('initAuth built the firebase provider', provider.kind === 'firebase')

  let observed
  const unsubscribe = provider.onAuthStateChanged((user) => {
    observed = user
  })

  check('no token before sign-in', (await provider.getIdToken()) === null)

  await provider.signIn({ email: EMAIL, password: PASSWORD })
  await new Promise((r) => setTimeout(r, 250)) // let the auth-state listener settle

  check('onAuthStateChanged reported a neutral AuthUser', observed != null)
  check(
    'AuthUser carries subject and email, not a Firebase User',
    observed != null &&
      typeof observed.subject === 'string' &&
      observed.subject.length > 0 &&
      observed.email === EMAIL &&
      !('uid' in observed) &&
      !('getIdToken' in observed),
    JSON.stringify(observed),
  )

  const token = await provider.getIdToken()
  check('provider yielded a bearer token', typeof token === 'string' && token.split('.').length === 3)

  // The real client, with no idea which provider is behind it.
  const me = await auth.apiClient.apiGet('/api/users/me')
  check('apiClient reached GET /api/users/me with that token', me != null && me.email === EMAIL, JSON.stringify(me))
  check(
    'backend returned the Switchboard user with memberships',
    Array.isArray(me?.memberships) && me.memberships.length > 0,
    JSON.stringify(me?.memberships),
  )
  console.log(
    `        ${me.email} -> user ${me.id}, ${me.memberships.map((m) => `${m.orgName}:${m.role}`).join(', ')}`,
  )

  const forced = await provider.getIdToken(true)
  check('forceRefresh mints a token the backend still accepts', typeof forced === 'string')

  unsubscribe()
  await provider.signOut()
  await new Promise((r) => setTimeout(r, 150))
  check('sign-out cleared the session', (await provider.getIdToken()) === null)

  return me
}

async function oidcLeg(firebaseUser) {
  const issuer = await startOidcIssuer({ port: OIDC_PORT })
  section(`Generic OIDC provider (local issuer on ${issuer.issuer})`)

  try {
    const auth = await bundleAuth({
      VITE_AUTH_PROVIDER: 'oidc',
      VITE_API_BASE_URL: API_BASE,
      VITE_OIDC_AUTHORITY: issuer.issuer,
      VITE_OIDC_CLIENT_ID: OIDC_CLIENT_ID,
      VITE_OIDC_AUDIENCE: OIDC_AUDIENCE,
      VITE_OIDC_SCOPE: 'openid profile email',
    })

    const config = auth.readAuthConfig()
    check('config selects the oidc provider', config.kind === 'oidc', `got ${config.kind}`)
    check('authority is the local issuer, not Firebase', config.authority === issuer.issuer)

    const { InMemoryWebStorage, User, UserManager } = await import('oidc-client-ts')
    // The browser storage the provider would otherwise pick up from `window`. Everything else
    // below is the dashboard's own code.
    globalThis.localStorage = new InMemoryWebStorage()

    const claims = {
      email: EMAIL,
      email_verified: true,
      name: 'Alice via OIDC',
    }
    const minted = issuer.mint(`oidc-subject-${Date.now()}`, OIDC_AUDIENCE, claims)

    // Stand in for the code exchange: put a real oidc-client-ts User into the real store, at the
    // real key, using the dashboard's own UserManager settings. This is the one step a headless
    // run cannot perform through the browser redirect.
    const seeded = new User({
      access_token: minted.token,
      // Deliberately different, so a provider that sent the wrong one would fail against the
      // backend's audience check rather than pass by luck.
      id_token: 'not-the-token-that-should-be-sent',
      token_type: 'Bearer',
      scope: config.scope,
      expires_at: minted.expiresAt,
      profile: {
        iss: issuer.issuer,
        sub: minted.token.split('.')[1] && JSON.parse(Buffer.from(minted.token.split('.')[1], 'base64url')).sub,
        aud: OIDC_AUDIENCE,
        exp: minted.expiresAt,
        iat: Math.floor(Date.now() / 1000),
        ...claims,
      },
    })
    await new UserManager(auth.oidcSettings(config, globalThis.localStorage)).storeUser(seeded)

    const provider = await auth.initAuth()
    check('initAuth built the oidc provider', provider.kind === 'oidc')

    let observed
    provider.onAuthStateChanged((user) => {
      observed = user
    })
    check(
      'restored session maps to the same neutral AuthUser shape',
      observed != null &&
        observed.subject === seeded.profile.sub &&
        observed.email === EMAIL &&
        observed.displayName === 'Alice via OIDC',
      JSON.stringify(observed),
    )

    const token = await provider.getIdToken()
    check('provider yielded the access token (audience is configured)', token === minted.token)

    const me = await auth.apiClient.apiGet('/api/users/me')
    check('apiClient reached GET /api/users/me with the OIDC token', me != null && me.email === EMAIL, JSON.stringify(me))
    check(
      'backend returned the Switchboard user with memberships',
      Array.isArray(me?.memberships) && me.memberships.length > 0,
      JSON.stringify(me?.memberships),
    )
    if (firebaseUser) {
      check(
        'same person, second issuer: the OIDC identity resolved to the Firebase user',
        me.id === firebaseUser.id,
        `${me.id} vs ${firebaseUser.id}`,
      )
    }
    console.log(
      `        ${me.email} -> user ${me.id}, ${me.memberships.map((m) => `${m.orgName}:${m.role}`).join(', ')}`,
    )

    // A real API call beyond the identity endpoint, to show the token is not special-cased.
    const orgs = await auth.apiClient.apiGet('/api/orgs')
    check('the same token works on a real management endpoint (GET /api/orgs)', Array.isArray(orgs) && orgs.length > 0)

    return true
  } catch (err) {
    if (String(err?.message ?? err).includes('401') || err?.status === 401) {
      console.log(`  FAIL  backend rejected the token from ${issuer.issuer}`)
      console.log('\n  The backend needs a provider for this issuer. Restart it with:\n')
      console.log(
        `  SPRING_APPLICATION_JSON='${JSON.stringify({
          switchboard: {
            auth: {
              providers: [
                { id: 'firebase-local', type: 'firebase', 'project-id': 'demo-switchboard' },
                {
                  id: 'local-oidc',
                  type: 'oidc',
                  issuer: issuer.issuer,
                  audience: OIDC_AUDIENCE,
                  'jwk-set-uri': issuer.jwkSetUri,
                },
              ],
            },
          },
        })}' make backend\n`,
      )
      failed++
      failures.push('oidc token accepted by backend')
      return false
    }
    throw err
  } finally {
    await issuer.close()
  }
}

async function main() {
  console.log(`Switchboard dashboard auth check — API ${API_BASE}`)
  let firebaseUser = null
  if (only !== 'oidc') firebaseUser = await firebaseLeg()
  if (only !== 'firebase') await oidcLeg(firebaseUser)

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
  if (failures.length) console.log(`Failed: ${failures.join(', ')}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFAIL  auth-check threw:', err)
  process.exit(1)
})
