# Switchboard dashboard

The web management surface for Switchboard. Flags, targeting, version history, segments, SDK
keys. The primary UI, and the only one — see [DECISIONS.md](../docs/DECISIONS.md) on the mobile
companion.

```bash
npm install
npm run dev          # http://localhost:5273
```

The backend and the auth emulator must be running first — from the repo root:

```bash
make deps-up         # postgres + firebase auth emulator
make backend         # spring boot on :28080
make seed            # demo org, project, environments, flags
```

## Ports

| What                   | Port  |
| ---------------------- | ----- |
| dashboard (this app)   | 5273  |
| backend API            | 28080 |
| Firebase Auth emulator | 29099 |
| postgres               | 25432 |

5273 rather than Vite's default 5173, so it can run alongside another dashboard on 5173.

## Logins

Seeded by `make seed`, password `password123` for all three:

| Email                  | Role                                       |
| ---------------------- | ------------------------------------------ |
| `alice@switchboard.dev`| OWNER of Acme Mobile                       |
| `bob@switchboard.dev`  | MEMBER of Acme Mobile                      |
| `carol@beta.dev`       | owner of a second org — use to prove isolation |

Out of the box the app authenticates through the Firebase Auth **emulator** (project
`demo-switchboard`) and sends the resulting ID token as a bearer token. The backend's local
profile also accepts `Bearer dev:<email>`, but that path is for node scripts only — the
dashboard always uses a real token from whichever provider is configured.

## Authentication

Switchboard's backend has no opinion about who authenticates your people: a token is verified
by whichever configured provider claims its `iss`, and identity is `(issuer, subject)` in
`user_identities`. The dashboard matches that. Firebase is one implementation of an auth seam,
generic OIDC is another, and which one is live is configuration.

```
src/auth/
├── types.ts                        AuthUser, DashboardAuthProvider — the seam
├── config.ts                       reads + validates VITE_AUTH_PROVIDER and its variables
├── index.ts                        selection, lazy load, the initAuth singleton
├── firebase/  firebaseAuthProvider.ts · mapUser.ts · errors.ts
└── oidc/      oidcAuthProvider.ts · settings.ts · mapUser.ts · errors.ts
```

Nothing above `src/auth/` knows which provider is running. `apiClient` asks the seam for a
bearer token, the auth context deals in a neutral `AuthUser` (`subject`, `email`,
`displayName`) rather than a Firebase `User`, and `LoginPage` renders the affordance the
active provider needs.

### Choosing a provider

| Variable                            | Default    | Notes                                        |
| ----------------------------------- | ---------- | -------------------------------------------- |
| `VITE_AUTH_PROVIDER`                | `firebase` | `firebase` or `oidc`                         |
| `VITE_API_BASE_URL`                 | `http://localhost:28080` | The management API              |

**`VITE_AUTH_PROVIDER=firebase`**

| Variable                            | Default                              |
| ----------------------------------- | ------------------------------------ |
| `VITE_FIREBASE_AUTH_EMULATOR_HOST`  | `http://localhost:29099` (blank = real Firebase) |
| `VITE_FIREBASE_PROJECT_ID`          | `demo-switchboard`                   |
| `VITE_FIREBASE_API_KEY`             | `demo-api-key` (emulator ignores it) |
| `VITE_FIREBASE_AUTH_DOMAIN`         | `demo-switchboard.firebaseapp.com`   |
| `VITE_FIREBASE_APP_ID`              | `demo-app-id`                        |

**`VITE_AUTH_PROVIDER=oidc`**

| Variable                            | Required | Notes                                                     |
| ----------------------------------- | -------- | --------------------------------------------------------- |
| `VITE_OIDC_AUTHORITY`               | yes      | The issuer, byte-identical to the token's `iss` and to the backend's `providers[].issuer` |
| `VITE_OIDC_CLIENT_ID`               | yes      | The SPA application's client id. No secret — see below     |
| `VITE_OIDC_SCOPE`                   | no       | Default `openid profile email`                             |
| `VITE_OIDC_AUDIENCE`                | no       | Set it whenever the backend provider has one. Also selects **which token is sent**: with an audience the access token, without one the id token |
| `VITE_OIDC_PROVIDER_NAME`           | no       | Sign-in button label. Defaults to the issuer host           |
| `VITE_OIDC_REDIRECT_URI`            | no       | Default `<origin>/auth/callback`                            |
| `VITE_OIDC_SILENT_REDIRECT_URI`     | no       | Default `<origin>/auth/silent-callback`                     |
| `VITE_OIDC_POST_LOGOUT_REDIRECT_URI`| no       | Default `<origin>/login`                                    |

A bad configuration is reported on first paint, naming the variable
(`VITE_OIDC_CLIENT_ID is required when VITE_AUTH_PROVIDER=oidc.`), rather than becoming a
mystery failure when someone clicks Sign in. That is the browser counterpart of the backend
refusing to boot on a malformed `switchboard.auth.providers` entry.

### The provider choice is a build-time choice

`src/auth/index.ts` picks the implementation by comparing against
`import.meta.env.VITE_AUTH_PROVIDER`, which Vite replaces with a **string literal at build
time**, and reaches each implementation through a dynamic `import()`. The bundler therefore
folds one branch away entirely:

| Build                          | JS emitted                                            |
| ------------------------------ | ----------------------------------------------------- |
| before this seam existed       | one 703 kB chunk, Firebase inside it                   |
| `VITE_AUTH_PROVIDER` unset/firebase | 352 kB entry + 104 kB `firebaseAuthProvider` chunk, loaded on demand |
| `VITE_AUTH_PROVIDER=oidc`      | 352 kB entry + 70 kB `oidcAuthProvider` chunk. **No Firebase chunk at all** |

Route-level lazy loading (2026-08-25) split the rest into 48 chunks and took the entry from
607 kB to 352 kB. Login and the auth callbacks stay eager: they are the first paint for a
signed-out visitor, so a chunk request in front of the login form would be latency for nothing.

An Okta deployment ships no `@firebase/*` code — `grep identitytoolkit dist/assets/*.js` finds
nothing, verified in both directions — and initialises no Firebase app. Switching providers means
rebuilding, not restarting.

### Why `oidc-client-ts`

The OIDC provider is authorization code **with PKCE**, the only correct flow for a browser SPA:
a public client cannot keep a secret, and the implicit flow puts tokens in the URL. It delegates
to [`oidc-client-ts`](https://github.com/authts/oidc-client-ts) rather than hand-rolling that
flow. PKCE verifier generation, `state` and `nonce` validation, the code exchange, refresh
rotation and the hidden-iframe silent renew are all security-critical, all easy to get subtly
wrong in ways that still appear to work, and that library is the de-facto standard
implementation. It is also 70 kB against Firebase's several hundred.

### How the callback route works

1. `ProtectedRoute` bounces a signed-out visitor to `/login`, carrying the path they wanted in
   the router's location state.
2. The sign-in button calls `provider.signIn({ returnTo })`. `oidc-client-ts` generates the PKCE
   verifier and `state`, stores both under the `switchboard.oidc.` prefix, and navigates to the
   IdP's authorization endpoint with `returnTo` packed into `state`.
3. The IdP authenticates the person and redirects to `/auth/callback?code=…&state=…`.
4. `AuthCallbackPage` calls `provider.handleRedirectCallback()`, which validates `state`, spends
   the code with the PKCE verifier, validates the `nonce` on the id token, stores the session,
   and hands back `returnTo`. The page navigates there. The exchange is latched behind a ref so
   StrictMode's double-invoked effect cannot spend the single-use code twice.
5. `/auth/silent-callback` is the target of `silent_redirect_uri`. It only ever renders inside
   the hidden iframe `automaticSilentRenew` opens, and renders nothing — nobody sees it.
6. Sign-out prefers RP-initiated logout when the IdP publishes an `end_session_endpoint`, so
   "sign out" is not immediately undone by the IdP's own session, and falls back to dropping the
   local session when it does not.

Both `/auth/*` routes sit outside `ProtectedRoute`: nobody is signed in yet when they land there.

`apiClient` retries a 401 exactly once, forcing a token refresh first. That covers a token that
expired between mint and use — a laptop waking up, an access token that outlived its silent
renew — for both providers. A genuinely revoked session fails on the second try rather than
looping.

### Worked example: Okta

In Okta, create an **OIDC → Single-Page Application** with grant type *Authorization Code* (Okta
enforces PKCE for SPAs), sign-in redirect URI `https://switchboard.acme.com/auth/callback` **and**
`https://switchboard.acme.com/auth/silent-callback`, sign-out redirect URI
`https://switchboard.acme.com/login`, and trusted origin `https://switchboard.acme.com`. Add an
audience of `switchboard-api` to the authorization server you use.

`dashboard/.env.production.local`:

```dotenv
VITE_API_BASE_URL=https://switchboard-api.acme.com
VITE_AUTH_PROVIDER=oidc
VITE_OIDC_AUTHORITY=https://acme.okta.com/oauth2/default
VITE_OIDC_CLIENT_ID=0oa1b2c3d4EXAMPLE
VITE_OIDC_AUDIENCE=switchboard-api
VITE_OIDC_PROVIDER_NAME=Acme SSO
```

The matching backend half (`switchboard.auth.providers`) — the `issuer` and `audience` must be
the same strings on both sides:

```yaml
switchboard:
  auth:
    providers:
      - id: acme-okta
        type: oidc
        issuer: https://acme.okta.com/oauth2/default
        audience: switchboard-api
```

Auth0 is the same shape with `VITE_OIDC_AUTHORITY=https://acme.us.auth0.com/` (trailing slash
included, because that is what its `iss` carries) and the API identifier as the audience. Entra
ID, Keycloak, Cognito and Google are in the backend README's per-IdP table.

Leaving the audience unset on both sides is also valid — the dashboard then sends the id token
and the backend validates only the issuer. Set it on both or neither; setting it on one side
only is the mistake that produces a 401 with nothing wrong in the logs.

### Verifying it

`npm run auth-check` proves both paths against a running backend, through the shipping code:
`scripts/lib/bundle-auth.mjs` compiles `src/auth` and `src/lib/apiClient` for node with
`VITE_AUTH_PROVIDER` baked in exactly as a browser build would, so the selection branch it
exercises is the one in `dist`.

- **Firebase leg** — signs in as `alice@switchboard.dev` against the emulator through the real
  `firebaseAuthProvider`, asserts the neutral `AuthUser` mapping, and calls
  `GET /api/users/me` through the real `apiClient`.
- **OIDC leg** — stands up a real OIDC issuer in-process (`scripts/lib/oidc-issuer.mjs`: RSA key
  pair, JWKS endpoint, discovery document, RS256 minter — the node counterpart of the backend's
  `TestOidcIssuer`), mints a signed token, puts it through the real provider's storage and
  `getIdToken`, and calls the API through the real `apiClient`. Point the backend at that issuer
  first; the script prints the exact `SPRING_APPLICATION_JSON` if you have not:

```bash
SPRING_APPLICATION_JSON='{"switchboard":{"auth":{"providers":[
  {"id":"firebase-local","type":"firebase","project-id":"demo-switchboard"},
  {"id":"local-oidc","type":"oidc","issuer":"http://127.0.0.1:29199",
   "audience":"switchboard-dashboard","jwk-set-uri":"http://127.0.0.1:29199/jwks.json"}]}}}'   make backend

cd dashboard && npm run auth-check
```

#### What stays manual

The browser redirect itself cannot be driven headlessly, so `auth-check`'s OIDC leg begins one
step downstream of it. Against a real IdP, verify by hand:

1. `/login` shows "Sign in with &lt;provider&gt;" and the button leaves for the IdP's
   authorization endpoint with `response_type=code`, `code_challenge` and `code_challenge_method=S256`.
2. The IdP returns to `/auth/callback` and you land on the page you originally asked for, not on
   `/flags`, when you deep-linked into a protected route.
3. A replayed callback URL shows "That sign-in link has expired or was already used" rather than
   a raw `invalid_grant`.
4. Cancelling at the IdP returns you to a readable message, not a stack trace.
5. Leaving a tab open past the access token's lifetime keeps working — the silent renew iframe
   hits `/auth/silent-callback` and no request 401s.
6. Sign-out ends the IdP session too, so clicking Sign in again asks for credentials.

Everything below the redirect — token selection, storage, `getIdToken`, the `apiClient` bearer,
the backend's acceptance of the issuer — is covered by `npm run auth-check`.

## Configuration

See **Authentication** above for the auth variables. Everything defaults to the local stack, so
a clean checkout runs with no `.env` file; override in `.env.local` (see `.env.example`).

## Scripts

| Command                       | What it does                                              |
| ----------------------------- | --------------------------------------------------------- |
| `npm run dev`                 | Vite dev server on 5273                                    |
| `npm run build`               | Typecheck + production build                               |
| `npm run check`               | `tsc -b` + `eslint .` + `vitest run` — the pre-push gate    |
| `npm test`                    | Unit tests                                                 |
| `npm run generate:api-types`  | Regenerate types from the backend's OpenAPI spec           |
| `npm run service-check`       | Live end-to-end check against a running backend            |
| `npm run ai-check`            | Live check of the AI, monitor and audit endpoints          |
| `npm run governance-check`    | Live check of change requests, approvals and permissions   |
| `npm run auth-check`          | Live check of both auth providers — see **Authentication** |

## API types are generated, the client is not

`src/types/generated/switchboard-api.d.ts` comes from the backend's
`src/main/resources/openapi/switchboard-api.yaml` via
[`openapi-typescript`](https://openapi-ts.dev/) — **types only**. It is committed, because
`npm run build` must never depend on a backend checkout being present.

```bash
npm run generate:api-types
# or, pointing at a backend elsewhere:
SWITCHBOARD_BACKEND_DIR=/path/to/backend npm run generate:api-types
```

Application code imports friendly aliases from `src/types/api.ts`, never from the generated
file directly. Every HTTP call goes through the hand-written `src/lib/apiClient.ts`, which
owns auth headers, the `{ error, message }` envelope, and the typed error classes
(`ApiClientError`, `ConflictError`, `NetworkError`). See
`src/types/generated/README.md` for the full contract.

## Live service check

`scripts/service-check.mjs` is plain node against a running backend. It walks every endpoint
the api modules call — list and filter flags, flag detail, create a throwaway flag, a full
targeting PUT, a deliberately stale `expectedVersion` to prove the 409, kill switch on and
off, version history, rollback, segment CRUD including the referenced-segment 409, SDK key
create and revoke — and asserts each response carries the fields the generated types say it
does. It cleans up everything it creates.

```bash
npm run service-check                          # http://localhost:28080
API_BASE=http://host:port npm run service-check
```

Exit code is 0 on PASS, 1 on FAIL. Run it after any backend API change; a drift between the
spec and the running service shows up here rather than as a broken page.

`scripts/ai-check.mjs` is its companion for the AI surface: proposal list / filter / fetch,
the 503 `AI_UNAVAILABLE` draft path (and the 400 that must stay distinguishable from it),
anomaly list + acknowledge + the 409 on re-acknowledging, rollout-stats shapes with an
assertion that every rate is a 0..1 fraction and that bucketed evaluations add up to the
totals, audit paging and filters, and an org-settings PUT round-trip.

```bash
npm run ai-check
```

It writes two things: it acknowledges one OPEN anomaly finding (there is no un-acknowledge,
by design) and round-trips one setting back to its original value. Regenerate findings with:

```bash
curl -X POST localhost:28080/api/jobs/rollout-scan -H 'X-Job-Token: local-job-token'
```

Findings are deduplicated per flag, variation and window hour, so a rescan inside the same
hour is a no-op — a fresh OPEN finding appears on the next hour's scan.

## Conventions

- **No React Query.** Pages own their data with `useState` + `useEffect` + an async `load()`,
  with explicit `loading` / `error` / `refreshing` flags, and `useToast()` for write feedback.
- **Semantic tokens only.** No raw hex, no `amber-500`. Use `warning`, `ok`, `destructive`,
  `info`, `muted`, and the `env-*` identity tokens. Everything must read in light and dark.
- **Environment colour is identity, not state.** `dev` / `staging` / `production` each get
  their own hue (`src/lib/envColors.ts`); unknown env keys fall back to neutral. Those hues
  are deliberately disjoint from `ok` (enabled) and `destructive` (killed) so a chip can never
  be misread.
- **Variation colour is a fourth palette.** `--series-1` … `--series-5` (`src/lib/variantSeries.ts`)
  colour per-variation bars, dots and chart lines. Disjoint from BOTH the state palette and
  the env identity hues, and assigned positionally so one variation keeps one colour across
  the rollout bar, the comparison table and the time series. Never hash a colour.
- **Rates from the API are 0..1 fractions.** Only `formatRate` multiplies by 100.
- **No charting library.** The rollout time series is inline SVG in
  `src/components/VariantSeriesChart.tsx`, reading `--series-*` so it follows the theme.
- **Tab state lives in `?tab=`** via `useSearchParams`; the flags list keeps its search and
  tag filter in `?q=` / `?tag=`, the activity feed its `?project=` / `?env=` / `?flag=`,
  the proposals list its `?status=`, and the monitor screens their `?hours=` window.
- **Optimistic concurrency is a UI flow, not an error.** A 409 from a targeting save raises
  `ConflictError`, and the targeting tab renders a "changed elsewhere" banner offering to load
  the current config — never a generic toast.
- **`data-testid` on primary interactive elements**, for the e2e pass.
- **Auth goes through the seam.** `firebase/*` is importable only inside `src/auth/firebase/`
  and `oidc-client-ts` only inside `src/auth/oidc/`; everything else deals in `AuthUser` and
  `DashboardAuthProvider`. A guard test enforces both — one stray import puts an SDK back into
  the entry chunk and silently breaks the other provider's build.

## Layout

```
src/
├── components/
│   ├── layout/     AppLayout (sidebar), WorkspaceSwitchers (org → project → env), PageHeading
│   ├── ui/         shadcn primitives (button, dialog, alert-dialog, select, tabs, table, …)
│   └── …           EnvChip, FlagEnvStateChip, EmptyState, InfoCallout, ProtectedRoute,
│                   RolloutBar, RateBar, VariantSeriesChart
├── auth/           the provider seam: types, config, selection; firebase/ and oidc/ impls
├── context/        AuthProvider (auth seam + /api/users/me), WorkspaceProvider (org/project/env)
├── hooks/          useAuth, useWorkspace
├── lib/            apiClient + per-domain api modules (flagsApi, segmentsApi, aiApi,
│                   monitorApi, auditApi, orgsApi, projectsApi), envColors, rollout,
│                   variantSeries, rolloutStats, diffSummary, auditDisplay, flagKey, format
├── pages/          FlagsPage, FlagDetailPage (+ flags/*, including the ?tab=monitor rollout
│                   detail), SegmentsPage, MonitorPage (+ monitor/*), ActivityPage,
│                   ai/ (ProposalsPage, ProposalDetailPage, DiffPreview, AskAiDialog),
│                   SettingsPage (+ settings/AiTab), LoginPage, AuthCallbackPage,
│                   AuthSilentCallbackPage
└── types/          api.ts (aliases) + generated/ (committed codegen)
```
