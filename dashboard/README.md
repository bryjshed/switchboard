# Switchboard dashboard

The web management surface for Switchboard. Flags, targeting, version history, segments, SDK
keys. The mobile app keeps the kill switch in your pocket; this is where the work gets done.

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

The app authenticates through the Firebase Auth **emulator** (project `demo-switchboard`) and
sends the resulting ID token as a bearer token. The backend's local profile also accepts
`Bearer dev:<email>`, but that path is for node scripts only — the dashboard always uses a
real emulator token.

## Configuration

Everything defaults to the local stack, so a clean checkout runs with no `.env` file. Override
in `.env.local` (see `.env.example`):

| Variable                             | Default                                  |
| ------------------------------------ | ---------------------------------------- |
| `VITE_API_BASE_URL`                  | `http://localhost:28080`                 |
| `VITE_FIREBASE_AUTH_EMULATOR_HOST`   | `http://localhost:29099` (blank = real Firebase) |
| `VITE_FIREBASE_PROJECT_ID`           | `demo-switchboard`                       |
| `VITE_FIREBASE_API_KEY`              | `demo-api-key` (emulator ignores it)     |

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

## Layout

```
src/
├── components/
│   ├── layout/     AppLayout (sidebar), WorkspaceSwitchers (org → project → env), PageHeading
│   ├── ui/         shadcn primitives (button, dialog, alert-dialog, select, tabs, table, …)
│   └── …           EnvChip, FlagEnvStateChip, EmptyState, InfoCallout, ProtectedRoute,
│                   RolloutBar, RateBar, VariantSeriesChart
├── context/        AuthProvider (Firebase + /api/users/me), WorkspaceProvider (org/project/env)
├── hooks/          useAuth, useWorkspace
├── lib/            apiClient + per-domain api modules (flagsApi, segmentsApi, aiApi,
│                   monitorApi, auditApi, orgsApi, projectsApi), envColors, rollout,
│                   variantSeries, rolloutStats, diffSummary, auditDisplay, flagKey, format
├── pages/          FlagsPage, FlagDetailPage (+ flags/*, including the ?tab=monitor rollout
│                   detail), SegmentsPage, MonitorPage (+ monitor/*), ActivityPage,
│                   ai/ (ProposalsPage, ProposalDetailPage, DiffPreview, AskAiDialog),
│                   SettingsPage (+ settings/AiTab), LoginPage
└── types/          api.ts (aliases) + generated/ (committed codegen)
```
