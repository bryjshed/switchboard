import { configSource } from './runtimeConfig'

// Configuration, resolved through `runtimeConfig` so one built image can serve any environment:
// the container writes `config.js` from its environment and it layers over the build-time
// defaults. Defaults target the local stack documented in the README (backend :28080), so a
// clean checkout runs with no .env file and no config.js at all.
//
// Auth configuration is NOT here: it is read and validated by `src/auth/config.ts`, which owns
// the provider selection and the per-provider variables. It reads the same source.
function apiBaseUrl(): string {
  const value = configSource()['VITE_API_BASE_URL']
  return (typeof value === 'string' ? value.trim() : '') || 'http://localhost:28080'
}

export const env = {
  get apiBaseUrl(): string {
    return apiBaseUrl()
  },
}
