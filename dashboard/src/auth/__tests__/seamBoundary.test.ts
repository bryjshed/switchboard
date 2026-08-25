import { describe, expect, it } from 'vitest'

/**
 * The seam is only worth anything while it holds. One `import { auth } from 'firebase/auth'` in
 * a page puts the SDK back into the entry chunk and quietly breaks the promise that an Okta
 * deployment ships no Firebase — a regression no behavioural test would catch, because the app
 * would still work perfectly on the Firebase path.
 *
 * The sources are read through `import.meta.glob` rather than `node:fs` so this stays an
 * ordinary browser-environment test.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** `/src/pages/LoginPage.tsx` → `pages/LoginPage.tsx`. Tests may import either SDK. */
function shippedFiles(): [string, string][] {
  return Object.entries(sources)
    .map(([path, source]) => [path.replace('/src/', ''), source] as [string, string])
    .filter(([path]) => !path.includes('__tests__') && !path.startsWith('types/generated/'))
}

function importersOf(pattern: RegExp, allowedPrefix: string): string[] {
  return shippedFiles()
    .filter(([path, source]) => pattern.test(source) && !path.startsWith(allowedPrefix))
    .map(([path]) => path)
}

describe('auth seam boundaries', () => {
  it('finds the dashboard sources at all (a silent empty glob would pass everything)', () => {
    expect(shippedFiles().length).toBeGreaterThan(50)
  })

  it('confines the Firebase SDK to src/auth/firebase/', () => {
    expect(importersOf(/from ['"]firebase\//, 'auth/firebase/')).toEqual([])
  })

  it('confines oidc-client-ts to src/auth/oidc/', () => {
    expect(importersOf(/from ['"]oidc-client-ts['"]/, 'auth/oidc/')).toEqual([])
  })

  it('keeps the mappers and error maps free of both SDKs, so either build can import them', () => {
    const shared = [
      'auth/firebase/errors.ts',
      'auth/firebase/mapUser.ts',
      'auth/oidc/errors.ts',
      'auth/oidc/mapUser.ts',
    ]
    for (const file of shared) {
      const source = sources[`/src/${file}`]
      expect(source, `${file} is missing`).toBeDefined()
      expect(source).not.toMatch(/from ['"](firebase\/|oidc-client-ts)/)
    }
  })
})
