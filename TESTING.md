# Testing Switchboard by hand

Automated gates first (`make test`, `make smoke`, `make check`). This file covers what
those cannot: the flows a person has to look at.

## Setup

```bash
make deps-up && make backend      # backend on :28080
make seed                         # demo data; prints SDK keys — copy them somewhere
make dashboard                    # web UI on :5273  <- sign in here
```

The web dashboard is the primary and only UI. (There was an Expo companion; it was deleted on
2026-08-24 — see docs/DECISIONS.md.)

Logins, all password `password123`:

| User | Role |
|---|---|
| alice@switchboard.dev | owner of Acme Mobile |
| bob@switchboard.dev | member of Acme Mobile |
| carol@beta.dev | owner of Beta Labs (a separate org) |

Reset everything: `docker compose down -v && make deps-up`, restart the backend, re-seed.

### Seeded flags and what each one is for

| Flag | State | Exercises |
|---|---|---|
| `new-checkout` | ramping 25% in prod, 50% staging, on in dev | ramp slider, version history (10% → rollback → 25%) |
| `planner-v2` | multivariate 60/20/20 | multi-variation UI, rollout weights |
| `pro-plan-features` | segment + `plan == pro` rule | rule editor, segment matching |
| `payment-provider-v2` | killed in production, with a reason | kill-switch state, red pill |
| `dark-mode` | 100% on, untouched 6 weeks | stale-flag sweep |
| `ios-push-refresh` | `platform == ios` rule with a 10% rollout inside it | per-rule rollouts |
| `debug-logging` | individual target for one user | individual targeting |
| `legacy-search` | 0%, untouched 6 weeks | retirement proposal |
| `agent-planner-prompt` | 50/50 prompt A/B scoped to one agent | gating an AI agent |

## The kill-switch drill (do this first, it is the product)

1. Open the dashboard at http://localhost:5273, Flags, `production` selected.
   `payment-provider-v2` shows a killed state chip.
2. In a terminal, evaluate it with the production SDK key:
   ```bash
   curl -s -X POST localhost:28080/api/eval/payment-provider-v2 \
     -H "Authorization: Bearer $SDK_KEY" -H 'Content-Type: application/json' \
     -d '{"context":{"key":"user-1"}}'
   ```
   Expect `"reason":"KILL_SWITCH"` and the off variation.
3. Open the flag, Targeting tab, and turn the kill switch off (it asks for a reason).
   Re-run the curl: the reason changes (`ROLLOUT` or `FLAG_OFF`).

**Expected:** under 30 seconds from opening the dashboard to traffic changing. On the
flag detail page the same drill is the kill-switch control in the header.

## Watching a change propagate

1. Hold a stream open with the production SDK key:
   ```bash
   curl -N localhost:28080/api/stream -H "Authorization: Bearer $SDK_KEY"
   ```
   You get a `put` event immediately with the whole environment.
2. Change `new-checkout`'s rollout percentage in the dashboard and save.
3. Within about a second the terminal prints a `patch` event carrying the new config and a
   higher `stateVersion`. `ping` arrives every 15s in between.

## Version history and rollback

1. `new-checkout` → History tab (production). You should see four versions: created,
   ramp 10%, a rollback, ramp 25%.
2. Tap a version to read its config, then roll back to v1.
3. Confirm: a NEW version appears at the top (history is append-only, never rewritten)
   and evaluation now returns `FLAG_OFF`.
4. Activity shows the rollback with your name against it.

## Optimistic updates and conflicts

1. Open the same flag's Targeting tab in two browser tabs.
2. Save a change in one; then save a stale edit from the other.
3. **Expected:** the stale save is refused with a "Changed elsewhere while you were editing"
   banner offering to load the current config or keep editing — never a silent clobber and
   never a generic error toast. This is the `expectedVersion` guard.
4. Stop the backend and toggle something: the optimistic change rolls back with a toast.

## Healing (auto-rollback)

1. Settings → AI tab → enable auto-rollback.
2. Trigger a scan: `curl -X POST localhost:28080/api/jobs/rollout-scan -H "X-Job-Token: local-job-token"`.
3. The seeded `payment-provider-v2` traffic has the treatment erroring at ~20% against ~2%.
4. **Expected:** an anomaly finding appears on the Monitor screen; with auto-rollback on
   it is marked
   `AUTO_ROLLED_BACK`, the flag's production config now serves 100% baseline, and Activity
   shows an `AI_APPLY` entry by `switchboard-monitor` (styled to stand out from human
   changes). The rollback is an ordinary version — you can roll it back yourself.

   Findings dedupe per flag+variation+window-hour, so re-scanning within the same hour is a
   no-op. If nothing new appears, wait for the next hour or seed fresh events.

## Optimizing (auto-ramp)

1. Enable auto-optimize in Settings → AI, then run the same scan.
2. `new-checkout`'s treatment converts better in the seeded data.
3. **Expected:** an optimization proposal ramping 25% → 50%, applied if auto-optimize is on.
   Open it under Proposals: the diff must read as prose ("fallthrough: 75% false / 25% true
   → 50% / 50%"), never raw JSON. Check the weights still sum to 100.

## Stale flags

`curl -X POST localhost:28080/api/jobs/stale-flag-scan -H "X-Job-Token: local-job-token"`

**Expected:** retirement proposals for `dark-mode` and `legacy-search` (both parked six
weeks), each with a removal checklist. Applying one archives the flag; evaluating it then
falls back to the SDK's own default.

## Gating an agent

The seeded `agent-planner-prompt` splits an agent's prompt revision 50/50, scoped by an
`agent` attribute:

```bash
curl -s -X POST localhost:28080/api/eval/agent-planner-prompt \
  -H "Authorization: Bearer $SDK_KEY" -H 'Content-Type: application/json' \
  -d '{"context":{"key":"agent-run-42","attributes":{"agent":"meal-planner"}}}'
```

Check: the same run id always returns the same variant (runs are reproducible); a context
without `agent: meal-planner` falls through to the baseline; the monitor's rollout stats
compare the two prompt revisions by error and conversion rate.

## Access control

- Sign in as bob: he sees Acme Mobile but cannot add members or mint SDK keys.
- Sign in as carol: she sees only Beta Labs. Acme's flags must be invisible to her.
- Revoke an SDK key in Settings, then evaluate with it: `401`.

## Natural-language flag creation

Click **Ask AI** on the Flags page. Without an `ANTHROPIC_API_KEY` on the server, the dialog
must explain calmly that AI drafting needs a model provider, note that monitoring, healing
and optimizing still work without one, and hide the submit button — no red, no error toast.
With a key configured, a prompt returns a DRAFT you review as a diff and then apply; the
applied change appears in Activity as an ordinary audited version.

## Theme and accessibility

Check every screen in light and dark (the dashboard has a theme toggle; on the simulator use
`xcrun simctl ui booted appearance dark`):

- surfaces stay separated (hairlines doing the work, no white-on-white),
- env pills and the kill-switch red are legible on both grounds,
- the accent appears about three times per screen, no more,
- flag keys render in the mono slot,
- with Reduce Motion on, the staggered list load-in and press-scale are gone but nothing
  breaks; with VoiceOver on, flag cards read as one item with a usable label.

## Known simplifications

- Metric attribution joins on context key within the window rather than a per-evaluation
  identifier: good enough to spot a regression, not an analytics product.
- Segments are project-scoped, not per-environment.
- Auth uses the Firebase emulator's REST endpoints; native Firebase is a later slice.
