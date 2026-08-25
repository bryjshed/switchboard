# Switchboard mobile

> **Unmaintained as of 2026-08-24.** The keep-or-drop question was decided in favour of drop:
> see [Product scope](../docs/DECISIONS.md#product-scope) for why. The code stays in the tree
> and still builds, but it is excluded from CI, it is not updated when an API contract changes,
> and it will drift. Everything below describes how it worked at the point it stopped being
> maintained.

The companion app — the kill switch in your pocket. Flags, targeting, version history and
rollback, the monitor, and AI proposals, on a phone. The [web dashboard](../dashboard/README.md)
is the primary management surface; this is the one you reach for when the pager goes off and you
are not at a desk.

Expo (expo-router, TanStack Query, semantic design tokens), iOS and Android, sharing the same
REST API as every other client.

**Status:** it builds, runs, and drives the real backend. Unit tests and lint are green. The
Maestro e2e suite is written but cannot run here — see [Known issues](#known-issues).

## Running it

The backend and the auth emulator must be up first. From the repo root:

```bash
make deps-up     # postgres + firebase auth emulator
make backend     # spring boot on :28080
make seed        # demo org, project, flags — the app expects a seeded workspace
make app         # metro on :8092, opens the iOS simulator
```

`make app` is `cd app && npx expo start --port 8092 --ios`, and the port is the important part.

**Metro runs on 8092, not the default 8081, on purpose.** A dev-client build resolves its bundler
by port, so if another Expo project is already serving 8081 the simulator attaches to *that*
bundler and loads a different project's JavaScript into Switchboard's native shell. It red-screens
on native modules Switchboard does not ship, and because the stack trace names files that exist in
both projects it reads like a Switchboard regression. Metro's own log cannot reveal it — Metro
reports bundling, never JS runtime exceptions. Moving off 8081 sidesteps the whole class of
problem, so do not "fix" a port conflict by moving back.

For a native build (required for the dev client, and for Maestro):

```bash
npx expo run:ios
```

`ios/` is a committed prebuild. Bundle id `io.switchboard.app`, matching the Maestro flows.

### Configuration

Everything defaults to the local stack, so a clean checkout runs with no env file. `EXPO_PUBLIC_*`
variables are inlined at bundle time (`shared/config.ts`):

| Variable | Default |
| --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | `http://localhost:28080` |
| `EXPO_PUBLIC_FIREBASE_EMULATOR_URL` | `http://localhost:29099` |
| `EXPO_PUBLIC_FIREBASE_API_KEY` | `fake-api-key` (the emulator ignores it) |

### Logins

Seeded by `make seed`, password `password123` for all three:

| Email | Role |
| --- | --- |
| `alice@switchboard.dev` | OWNER of Acme Mobile |
| `bob@switchboard.dev` | MEMBER of Acme Mobile |
| `carol@beta.dev` | owner of a second org — use to prove isolation |

Sign-in goes through the Firebase Auth **emulator's** REST API (`identitytoolkit`) and sends the
returned ID token as the bearer token. `features/auth/services` is deliberately the only module
that knows this: swapping in `@react-native-firebase/auth` later means replacing two functions
there and nothing above them.

## Layout

```
app/                    expo-router routes only — screens, no logic
  (auth)/               welcome, login
  (tabs)/               flags · monitor · activity · settings
  flag/[flagKey]/       detail · targeting · history · monitor
  ai/                   create · proposals · proposal/[id]
features/<domain>/      the actual work: flags, ai, audit, auth, orgs, sdkKeys
  services/             HTTP calls, typed against shared/api/types
  queries/ mutations/   TanStack Query options and mutations
  components/ lib/      domain UI and pure helpers
  stores/               zustand, only for client state
shared/
  api/                  client (auth header, error envelope, typed errors), queryKeys, types
  ui/                   the primitive kit: Button, Card, Sheet, Badge, ListItem, Skeleton, …
  theme/                tokens, palette, useTheme, persisted theme mode
  lib/ hooks/           env ordering, time formatting, usePullToRefresh
```

Import through the `@features/*` and `@shared/*` aliases; the relative-path escape hatch is only
for siblings inside one module.

**Server state is TanStack Query, client state is zustand over MMKV.** Query owns anything the
backend is the source of truth for. There are exactly three zustand stores, for what the backend
does not know: theme mode, the auth session, and the active org/project. MMKV is synchronous, so
the persisted theme and the saved token are there at store-creation time — no wrong-theme flash at
launch, and a relaunch stays signed in while `bootstrap()` re-validates the token against
`/api/users/me` behind the splash screen.

## Design tokens

**Semantic tokens only. No raw hex outside `shared/theme`.** Every colour comes from
`useTheme().tokens` — `surface.*`, `text.*`, `accent.*`, `border.*`, `status.*`, and the `tints.*`
environment identities. This is enforced, not encouraged:

```bash
npm run lint:tokens   # greps for #rrggbb under app/, features/, shared/ (minus shared/theme)
```

`__tests__/design-tokens.test.ts` goes further and pins the palette itself: the accent values in
both modes, contrast-safe small-text accents, and the dark elevation ladder rising monotonically
in luminance (`base < subtle < raised < elevated`). A "harmless" tweak to a surface colour that
flattens that ladder fails the test rather than quietly flattening the UI.

Environment colour is identity, not state: `dev` / `staging` / `production` each get a badge tint,
and unknown env keys fall back to neutral rather than inventing a hue.

## Checks

Run these from `app/`:

```bash
npm run check         # typecheck + eslint + jest + token lint — the pre-push gate
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm test              # jest (12 suites, 95 tests)
npm run lint:tokens
```

Two live checks run plain node against a running backend, no simulator involved. Both need a
seeded workspace, so pass the seeded owner — the built-in default actor is not a seeded user:

```bash
node scripts/service-check.mjs --as alice@switchboard.dev   # 41 assertions
node scripts/ai-check.mjs      --as alice@switchboard.dev   # 39 assertions
```

`service-check.mjs` walks the exact URLs and payloads `features/*/services` build and asserts every
field `shared/api/types.ts` declares is actually present and the right type — including the 409 on
a stale `expectedVersion`, kill switch on and off, and that a rollback writes a *new* version. It
creates one throwaway flag and archives it. `ai-check.mjs` is its counterpart for proposals,
anomalies, rollout stats and org settings. Run either after a backend API change and drift shows
up there rather than as a broken screen.

## End-to-end

Maestro flows live at the repo root in [`.maestro/`](../.maestro/README.md): sign in, ramp a flag,
the kill-switch drill, and history + rollback. They assert on `testID`s and leave a screenshot per
flow as evidence.

```bash
brew install maestro
# from the repo root:
maestro test .maestro/            # or one flow: maestro test .maestro/02-ramp-a-flag.yaml
```

## Known issues

**The e2e suite is blocked by a competing Metro on 8081.** The flows are written and correct, but
the dev client installed on the simulator attaches to whatever bundler holds 8081 and loads the
wrong project's JavaScript into this app's shell. Starting *this* app on 8092 does not help,
because the dev client's saved bundler URL is what it falls back to. Stop the other Metro, or run
the flows against a release build where that fallback does not apply. `.maestro/README.md` has the
full diagnosis, including why the red box is misleading.

**`npm run typecheck` fails once expo-router has generated typed routes.** `shared/ui/BackButton.tsx`
declares `fallbackHref?: string` and passes it to `router.replace()`. With `typedRoutes: true`,
`.expo/types/router.d.ts` narrows `Href` to a union of the real routes, and `string` is not
assignable to it. `.expo/` is gitignored, so a fresh clone typechecks clean and the error appears
only after Metro has run once. The fix is to type the prop as expo-router's `Href` rather than
`string`.
