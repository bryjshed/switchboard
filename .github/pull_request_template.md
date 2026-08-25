<!--
  Delete any section that does not apply. An empty heading is worse than a missing one.

  First time contributing? You will be asked to sign the CLA (.github/CLA.md) before this can
  be merged. It takes a moment and applies to every future contribution.
-->

## What this changes

<!-- One or two sentences. What is different after this merges. -->

## Why

<!-- The problem, not the patch. If it fixes an issue, "Fixes #123" here. -->

## How it was verified

<!--
  Paste the output, not a claim that it passed. CI runs everything below, but the author having
  run it is what keeps CI from being the first place a failure is discovered.

  Backend         cd backend && JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw verify
  Dashboard       cd dashboard && npm run check && npm run build
  SDK             cd sdk/typescript && npm run check
  MCP             cd mcp && npm run check
  Live checks     the seven scripts in CLAUDE.md, against a running stack
-->

```
```

## Checklist

<!-- Tick what applies. An unticked box with a reason next to it is a fine answer. -->

- [ ] **Evaluation behaviour**: if precedence, operators, segments or bucketing changed, this
      includes the `spec/evaluation.md` edit *and* regenerated conformance vectors **in this
      commit**. That rule is the only thing keeping the server and every SDK in agreement —
      `node spec/tools/generate-vectors.mjs --check` passes.
- [ ] **Flag writes** go through `FlagTargetingService`. Every one of them, including AI-applied
      and approval-applied. Rollback writes a *new* version; history is never rewritten.
- [ ] **Layering**: nothing Spring-, vendor- or JWT-shaped landed in `backend/.../domain/`.
- [ ] **API contract**: if `openapi/switchboard-api.yaml` changed, the generated dashboard types
      were regenerated in the same commit (`npm run generate:api-types`).
- [ ] **Migration**: numbered from the current head, and compatible with the *previous* version
      of the code — during a rolling deploy both run at once.
- [ ] **Docs**: `docs/REMAINING-WORK.md` updated if this closes a backlog item, and
      `docs/DECISIONS.md` if this makes a choice that will look wrong to the next reader.

## Anything a reviewer should push back on

<!--
  The most useful section here. A shortcut you took, a test you could not write, a case you are
  unsure about. Saying so is not a weakness in the PR; finding it in review is much cheaper than
  finding it in production.
-->
