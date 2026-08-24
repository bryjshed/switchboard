/**
 * Environment configuration. EXPO_PUBLIC_* vars are inlined at bundle time;
 * defaults target the local docker-compose stack.
 */
export const config = {
  /** Switchboard backend (management API). */
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:28080',
  /** Firebase Auth emulator (local-first auth bridge — see features/auth). */
  firebaseEmulatorUrl: process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_URL ?? 'http://localhost:29099',
  /** Any non-empty string works against the emulator. */
  firebaseApiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key',
} as const;
