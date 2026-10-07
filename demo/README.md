# Switchboard demo showcase

An interactive page for presenting Switchboard: one section per feature, each with a real
screenshot of the dashboard, a simulation you can drive live, and a technical-details panel for the
engineers in the room.

**Live at [bryjshed.github.io/switchboard](https://bryjshed.github.io/switchboard/)**: the project's
landing page. `.github/workflows/pages.yml` publishes this folder (the page, its scripts and
`shots/`, not the tooling) on every push to `main` that touches `demo/`, so regenerating the
screenshots and merging is all it takes to update the site.

**To present:** open the site, or `index.html` straight from disk. It needs no server and no running stack (fonts load
from Google Fonts when online and fall back to system fonts offline).

| Key | Does |
|---|---|
| ← → / Page Up / Page Down / Space | previous / next section (works with a presentation clicker) |
| `h` or the **Technical details** switch | show or hide the technical explanation at the end of every section |
| side menu | jump to any section; below laptop width it opens from the **Menu** button |
| `[` or the **‹** button | collapse the side menu to a rail of section numbers, for more room (remembered) |
| click a screenshot | full screen; click or Esc to close |

The strongest moments: **Metrics and tracking** (send traffic and watch exposures and `track()`
calls turn into evidence), **AI heals a bad rollout** (the evidence crossing the rollback line), and
its A/A panel (checking p < 0.05 every hour falsely rolls back about a quarter of identical
rollouts; Switchboard's test stays under its 5% bound).

## What is real

- **Screenshots** are captured from a seeded local instance by `scripts/shots.mjs`. The healing
  screens show a genuine rollback written by `switchboard-monitor`; nothing is mocked up.
- **The natural-language section** is a live capture of the Ask AI endpoint (`scripts/nl-proposal.json`
  is the raw response; `nl-data.js` renders it, with variation ids replaced by names).
- **Simulations** run ports of the product's own algorithms in `sim.js`: MD5 bucketing and rollout
  resolution (`spec/evaluation.md` §5), the evaluation ladder (§2) and the mixture sequential test
  (`MixtureSequentialTest.java`). `npm run verify` checks them against the conformance vectors, the
  spec's stated splits, and values printed by the compiled Java class.
- **Labelled "illustrative"**: the streaming animation (paced for the room, real frame format) and
  the MCP conversation (replayed, real tool names and responses).

## Regenerating

Do this after a UI change, so the screenshots match the product.

```bash
cd demo && npm install                  # playwright, for capture and QA

# a fresh local stack (from the repo root)
docker compose down -v && make deps-up
make backend                            # set ANTHROPIC_API_KEY too if you will re-run `npm run nl`
make seed
make dashboard

cd demo
npm run stage    # an AI rollback on payment-provider-v3, a pending change request, an invitation, a webhook
npm run shots    # all screenshots (dark mode) into shots/   (`npm run shots -- flags,first-run` for some)
npm run nl       # optional: re-capture Ask AI; then update nl-data.js from scripts/nl-proposal.json
npm run verify   # simulations vs spec vectors and the Java statistic
npm run qa       # opens index.html from disk: console errors, every simulation, phone width, both themes
```

`npm run stage` is not idempotent; run it once per fresh seed. Set `SHOTS_OUT=some/dir` to capture
somewhere other than `shots/` while testing.

After changing `MixtureSequentialTest`, refresh the Java reference values (repo root, backend built):

```bash
$(/usr/libexec/java_home -v 25)/bin/java -cp backend/target/classes demo/scripts/JavaVals.java > demo/scripts/java-values.json
```

## Files

| Path | What |
|---|---|
| `index.html` | the page: markup and styles |
| `app.js` | presenter controls and the simulations |
| `sim.js` | the product's algorithms, ported (shared by the page and `npm run verify`) |
| `nl-data.js` | the captured natural-language example |
| `shots/` | dashboard screenshots in dark mode, `<name>-dark.jpg` |
| `scripts/` | staging, capture, verification and QA scripts; `lib.mjs` holds the shared plumbing |
