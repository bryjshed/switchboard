// Build-time configuration. Defaults target the local stack documented in the README
// (backend :28080, Firebase Auth emulator :29099, project `demo-switchboard`), so a clean
// checkout runs with no .env file at all. Override any of these in `.env.local`.
export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:28080',
  firebase: {
    // The emulator ignores the key's value but the SDK requires a non-empty one.
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'demo-api-key',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'demo-switchboard.firebaseapp.com',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'demo-switchboard',
    appId: import.meta.env.VITE_FIREBASE_APP_ID || 'demo-app-id',
  },
  // Set to '' to talk to real Firebase instead of the emulator.
  authEmulatorHost:
    import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST ?? 'http://localhost:29099',
}
