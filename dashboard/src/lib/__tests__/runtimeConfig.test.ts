import { afterEach, describe, expect, it } from 'vitest'

import { buildTimeConflict, configSource } from '../runtimeConfig'

/**
 * These pin the contract between `dashboard/docker-entrypoint.d/10-runtime-config.sh`, which
 * writes `window.__SWITCHBOARD_CONFIG__`, and everything that reads configuration. Break it and
 * the failure is a deployed dashboard talking to the wrong API with nothing on screen to say so.
 */
function withRuntime(values: Record<string, string> | undefined): Window {
  return { __SWITCHBOARD_CONFIG__: values } as unknown as Window
}

afterEach(() => {
  delete window.__SWITCHBOARD_CONFIG__
})

describe('configSource', () => {
  it('falls back to build-time values when no config.js ran', () => {
    const source = configSource({ VITE_API_BASE_URL: 'http://localhost:28080' }, withRuntime(undefined))
    expect(source.VITE_API_BASE_URL).toBe('http://localhost:28080')
  })

  it('lets the container override a build-time value', () => {
    const source = configSource(
      { VITE_API_BASE_URL: 'http://localhost:28080' },
      withRuntime({ VITE_API_BASE_URL: 'https://api.example.com' }),
    )
    expect(source.VITE_API_BASE_URL).toBe('https://api.example.com')
  })

  it('ignores a blank runtime value rather than letting it shadow the default', () => {
    // This is how the entrypoint's template renders an unset variable. An empty API base URL
    // would send every request at the static server's own origin.
    const source = configSource(
      { VITE_API_BASE_URL: 'http://localhost:28080' },
      withRuntime({ VITE_API_BASE_URL: '   ' }),
    )
    expect(source.VITE_API_BASE_URL).toBe('http://localhost:28080')
  })

  it('never lets a runtime value take effect for a build-time-only key', () => {
    // The bundle physically does not contain the other provider, so honouring this would be a
    // lie that fails later, at sign-in.
    const source = configSource(
      { VITE_AUTH_PROVIDER: 'firebase' },
      withRuntime({ VITE_AUTH_PROVIDER: 'oidc' }),
    )
    expect(source.VITE_AUTH_PROVIDER).toBe('firebase')
  })

  it('survives a malformed config.js', () => {
    const source = configSource({ VITE_API_BASE_URL: 'http://localhost:28080' }, {
      __SWITCHBOARD_CONFIG__: 'not an object',
    } as unknown as Window)
    expect(source.VITE_API_BASE_URL).toBe('http://localhost:28080')
  })
})

describe('buildTimeConflict', () => {
  it('is silent when nothing disagrees', () => {
    expect(buildTimeConflict({ VITE_AUTH_PROVIDER: 'oidc' }, withRuntime({ VITE_AUTH_PROVIDER: 'oidc' })))
      .toBeNull()
    expect(buildTimeConflict({}, withRuntime({}))).toBeNull()
  })

  it('treats an unset build-time provider as firebase', () => {
    expect(buildTimeConflict({}, withRuntime({ VITE_AUTH_PROVIDER: 'firebase' }))).toBeNull()
  })

  it('names both values when the runtime asks for a provider that was not compiled in', () => {
    const message = buildTimeConflict({ VITE_AUTH_PROVIDER: 'firebase' }, withRuntime({ VITE_AUTH_PROVIDER: 'oidc' }))
    expect(message).toContain('VITE_AUTH_PROVIDER')
    expect(message).toContain('"oidc"')
    expect(message).toContain('"firebase"')
    // The message has to say what to DO, because the fix is a rebuild and nothing about the
    // symptom suggests that.
    expect(message).toContain('rebuild')
  })
})
