# Maestro e2e flows

Driven end-to-end tests against a real simulator. These assert on `testID`s, and each flow
leaves a screenshot behind as evidence.

## Before the first run

1. Bring up the stack and seed it: `make deps-up && make backend && make seed`.
2. Build and launch the app on a booted simulator: `cd app && npx expo run:ios`.

The flows hardcode `appId: io.switchboard.app` (matching `app/app.json`). Maestro does NOT
read shell environment variables — if you ever parameterize it, pass `-e APP_ID=...` on the
command line, or the flow launches a bundle literally named `undefined`.

`brew install maestro` if you do not have it. Run one flow with
`maestro test .maestro/02-ramp-a-flag.yaml`, or the lot with `maestro test .maestro/`.

## Flows

| File | Journey |
|---|---|
| `01-login.yaml` | Sign in as the seeded owner (used by the others via `runFlow`) |
| `02-ramp-a-flag.yaml` | The primary journey: sign in → flags list → open `new-checkout` → ramp production to 50% → confirm the audit entry |
| `03-kill-switch.yaml` | The drill: long-press a card → confirm → the pill flips |
| `04-history-rollback.yaml` | Version history → roll back → a NEW version appears |

## Notes

- Seeded logins use password `password123`; `alice@switchboard.dev` is the owner.
- Flows are written against the seed, so re-seed (or reset with `docker compose down -v`)
  if a previous run left a flag in a different state.
- `assertVisible` on a `testID` is the contract; text assertions are avoided except where
  the copy is the point.

## Known blocker: a competing Metro on :8081

If another Expo project is running `expo start` on the default port 8081, the dev client
installed on the simulator will attach to **that** bundler and load the wrong project's
JavaScript into Switchboard's native shell. It red-screens on native modules Switchboard
does not ship (`RNFBAppModule`, `AsyncStorage`), and the stack trace names files that exist
in both projects — so it reads like a Switchboard regression when it is not.

Metro's own log cannot reveal this: it reports bundling only, never JS runtime exceptions.
Diff the source shown in the red box against the real file to identify it.

Before running these flows, either stop the competing Metro, or run against a **release
build** of the app, where the dev-client bundler-URL fallback does not apply. `clearState:
true` makes it more likely by wiping the saved bundler URL on every launch.
