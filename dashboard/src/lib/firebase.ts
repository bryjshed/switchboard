import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, browserLocalPersistence, setPersistence } from 'firebase/auth'
import { env } from './env'

export const app = initializeApp(env.firebase)
export const auth = getAuth(app)

// Local development routes auth at the Firebase Auth emulator the docker stack runs
// (default http://localhost:29099). Blank VITE_FIREBASE_AUTH_EMULATOR_HOST for real Firebase.
export const usingAuthEmulator = Boolean(env.authEmulatorHost)
if (env.authEmulatorHost) {
  connectAuthEmulator(auth, env.authEmulatorHost, { disableWarnings: true })
}

// Survive a page reload. Firebase defaults to local persistence in browsers already, but
// stating it makes the session guarantee explicit rather than dependent on the default.
void setPersistence(auth, browserLocalPersistence)
