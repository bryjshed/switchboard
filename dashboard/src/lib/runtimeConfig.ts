/**
 * Configuration, resolved at RUNTIME rather than at build time.
 *
 * A Vite build folds `import.meta.env.VITE_*` into the bundle as string literals, which means a
 * built image is pinned to one API URL and one IdP. That is fine for a laptop and wrong for a
 * deployment: staging and production would need two different images of the same commit, and
 * "did we deploy the right build" becomes a question anyone can get wrong.
 *
 * So the container writes a small `config.js` from its environment at start-up, ahead of the
 * bundle:
 *
 *     window.__SWITCHBOARD_CONFIG__ = { VITE_API_BASE_URL: "https://api.example.com" }
 *
 * and everything that reads configuration reads it through `configSource()`, which layers that
 * object over `import.meta.env`. One image, any environment, no rebuild.
 *
 * ## The one thing that cannot move to runtime
 *
 * `VITE_AUTH_PROVIDER` selects which auth implementation is BUNDLED -- `src/auth/index.ts` sits
 * the two `import()`s either side of a literal comparison so the bundler drops the losing branch
 * entirely. A build with `VITE_AUTH_PROVIDER=oidc` does not contain Firebase at all, so no
 * runtime value can conjure it back.
 *
 * Such a key is therefore never merged, and a runtime value that DISAGREES with the built one is
 * reported by `buildTimeConflict()`. The failure that prevents is the quiet kind: an operator
 * sets the variable, sees the login page render, and finds out the wrong IdP is wired in only
 * when somebody tries to sign in.
 *
 * Nothing here throws. `configSource()` runs during module initialisation of anything that reads
 * configuration, and a throw there is a blank page with a console message; the conflict is
 * surfaced instead through `readAuthConfig`, which already has a full-screen error to render it
 * in.
 */

/** The subset of an env bag that this app reads: `VITE_*` string values. */
export type ConfigSource = Record<string, string | boolean | undefined>

declare global {
  interface Window {
    __SWITCHBOARD_CONFIG__?: Record<string, string>
  }
}

/**
 * Keys the bundler resolves and a running page therefore cannot change.
 *
 * Anything added here must genuinely change what is COMPILED, not merely what is read. A key
 * listed by mistake silently ignores a legitimate override.
 */
const BUILD_TIME_ONLY = ['VITE_AUTH_PROVIDER'] as const

/** Unset means Firebase — a clean checkout runs the local stack with no `.env` at all. */
const BUILD_TIME_DEFAULTS: Record<string, string> = { VITE_AUTH_PROVIDER: 'firebase' }

function runtimeValues(win: Window | undefined): Record<string, string> {
  const raw = win?.__SWITCHBOARD_CONFIG__
  if (!raw || typeof raw !== 'object') return {}
  // A blank value is how a template renders an unset variable, and it must not shadow the
  // build-time default with an empty string.
  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
  )
}

function currentWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window
}

/**
 * The effective configuration: runtime over build-time, minus the keys that cannot move.
 *
 * Called on every read rather than memoized, so a test can set `window.__SWITCHBOARD_CONFIG__`
 * and see the effect without reloading a module.
 */
export function configSource(
  buildTime: ConfigSource = import.meta.env,
  win: Window | undefined = currentWindow(),
): ConfigSource {
  const runtime = runtimeValues(win)
  for (const key of BUILD_TIME_ONLY) {
    delete runtime[key]
  }
  return { ...buildTime, ...runtime }
}

/**
 * The message for a runtime override of a build-time-only key, or null when there is none.
 *
 * Callers turn this into whatever error type they already render.
 */
export function buildTimeConflict(
  buildTime: ConfigSource = import.meta.env,
  win: Window | undefined = currentWindow(),
): string | null {
  const runtime = runtimeValues(win)
  for (const key of BUILD_TIME_ONLY) {
    const wanted = runtime[key]?.trim()
    if (!wanted) continue
    const raw = buildTime[key]
    const built = (typeof raw === 'string' ? raw.trim() : '') || BUILD_TIME_DEFAULTS[key]
    if (wanted !== built) {
      return (
        `${key} is "${wanted}" in the runtime configuration but this bundle was built with ` +
        `"${built}". That choice decides which implementation is compiled in, so it cannot be ` +
        `changed after the build — rebuild the image with ${key}=${wanted}.`
      )
    }
  }
  return null
}
