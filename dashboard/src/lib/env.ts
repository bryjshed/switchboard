// Build-time configuration. Defaults target the local stack documented in the README
// (backend :28080), so a clean checkout runs with no .env file at all. Override in `.env.local`.
//
// Auth configuration is NOT here: it is read and validated by `src/auth/config.ts`, which owns
// the provider selection and the per-provider variables.
export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:28080',
}
