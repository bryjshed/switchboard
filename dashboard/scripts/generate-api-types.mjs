#!/usr/bin/env node
/**
 * Regenerates `src/types/generated/switchboard-api.d.ts` from the backend's OpenAPI spec.
 *
 * The generated file is COMMITTED on purpose: `npm run build` must never depend on a
 * backend checkout being present. This is a developer tool — run it after
 * switchboard-api.yaml changes, then commit the result.
 *
 * The spec lives in a sibling directory of this one inside the switchboard repo, but this
 * package is also checked out as a worktree (`<repo>/.worktrees/<name>/dashboard`), so a
 * single hardcoded relative path is wrong in one of those cases. We walk up from the
 * package root looking for a `backend/` directory that actually holds the spec.
 * Override with SWITCHBOARD_BACKEND_DIR when the backend lives somewhere else.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SPEC_SUBPATH = 'src/main/resources/openapi/switchboard-api.yaml'
const OUT_PATH = 'src/types/generated/switchboard-api.d.ts'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`\n[generate-api-types] ${message}\n`)
  process.exit(1)
}

function findSpec() {
  if (process.env.SWITCHBOARD_BACKEND_DIR) {
    const explicit = join(resolve(process.env.SWITCHBOARD_BACKEND_DIR), SPEC_SUBPATH)
    if (!existsSync(explicit)) {
      fail(`SWITCHBOARD_BACKEND_DIR is set but no spec at:\n  ${explicit}`)
    }
    return explicit
  }
  // Walk up: <repo>/dashboard (one level) and <repo>/.worktrees/<name>/dashboard (three).
  let dir = pkgRoot
  for (let i = 0; i < 5; i++) {
    dir = dirname(dir)
    const candidate = join(dir, 'backend', SPEC_SUBPATH)
    if (existsSync(candidate)) return candidate
  }
  fail(
    'Could not find the switchboard backend alongside this package.\n' +
      `Looked for */backend/${SPEC_SUBPATH} walking up from:\n  ${pkgRoot}\n\n` +
      'Set SWITCHBOARD_BACKEND_DIR=/path/to/backend to point at it explicitly.\n' +
      'You do NOT need this to build — the generated types are committed.'
  )
}

const spec = findSpec()
const out = join(pkgRoot, OUT_PATH)
mkdirSync(dirname(out), { recursive: true })

console.log(`[generate-api-types] spec: ${spec}`)
execFileSync('npx', ['openapi-typescript', spec, '-o', out], { cwd: pkgRoot, stdio: 'inherit' })
console.log(`[generate-api-types] wrote ${OUT_PATH} — commit it.`)
