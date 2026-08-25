import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { build } from 'vite'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const VIRTUAL_ID = 'virtual:switchboard-auth-entry'

/**
 * Compiles the dashboard's real auth modules for node.
 *
 * The point of this file is that the live check exercises the shipping code, not a
 * reimplementation of it: the same `initAuth` that the app calls, over the same
 * `readAuthConfig`, feeding the same `apiClient`. `VITE_AUTH_PROVIDER` and friends are baked in
 * by Vite exactly as they are for a browser build, which means the provider-selection branch
 * under test here is literally the one that ships.
 */
export async function bundleAuth(env) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value

  // Inside node_modules (gitignored) rather than a temp dir: the bundle keeps `firebase` and
  // `oidc-client-ts` as bare imports, so it has to sit somewhere node can resolve them from.
  const outDir = mkdtempSync(join(ROOT, 'node_modules', '.switchboard-auth-check-'))
  await build({
    root: ROOT,
    logLevel: 'error',
    configFile: false,
    resolve: { alias: { '@': SRC } },
    plugins: [
      {
        name: 'switchboard-auth-entry',
        resolveId: (id) => (id === VIRTUAL_ID ? `\0${VIRTUAL_ID}` : null),
        load: (id) =>
          id === `\0${VIRTUAL_ID}`
            ? [
                "export * from '@/auth'",
                "export { oidcSettings, tokenFor } from '@/auth/oidc/settings'",
                "export * as apiClient from '@/lib/apiClient'",
              ].join('\n')
            : null,
      },
    ],
    build: {
      ssr: true,
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: VIRTUAL_ID,
        output: { entryFileNames: 'auth-entry.mjs', format: 'es' },
      },
    },
  })

  // Swept at exit rather than after the import: the provider implementations are separate
  // chunks that `initAuth()` pulls in lazily, exactly as they are in the browser, so the
  // directory has to outlive this call.
  process.on('exit', () => rmSync(outDir, { recursive: true, force: true }))

  return import(pathToFileURL(join(outDir, 'auth-entry.mjs')).href)
}
