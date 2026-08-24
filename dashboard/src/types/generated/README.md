# Generated API types

`switchboard-api.d.ts` is generated from the backend's
`src/main/resources/openapi/switchboard-api.yaml` by
[`openapi-typescript`](https://openapi-ts.dev/) — types only, no runtime code, no HTTP
client. `src/lib/apiClient.ts` still owns every actual request: auth headers, error
envelope parsing, and typed error classes (`ApiClientError`, `ConflictError`) are all
hand-written there.

## Do not hand-edit this file

Regenerate it instead:

```
npm run generate:api-types
```

`scripts/generate-api-types.mjs` walks up from this package looking for a `backend/`
directory that holds the spec, so it works whether the dashboard sits at `<repo>/dashboard`
or inside a linked worktree. Point it somewhere else with
`SWITCHBOARD_BACKEND_DIR=/path/to/backend npm run generate:api-types`.

## It reads whatever branch the backend checkout is on

The script resolves a *directory*, not a revision. If the API change you are generating
against lives on a branch the backend checkout is not on, generation succeeds and the types
simply lack your new schemas. Sanity-check that a schema you expect is present before
committing.

## Why the generated file is committed

CI has no backend checkout, and `npm run build` must never depend on one — it builds from
this committed file. Run the generate script locally after an API change and commit the
result; that is what keeps this file in sync, not CI.

## How it is consumed

`src/types/api.ts` re-exports friendly aliases (`FlagDetail`, `FlagTargetingConfig`, …)
pointing at `components['schemas'][...]`. Import from there, not from this file — and never
redeclare a type this file already generates.
