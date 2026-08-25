import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth'
import type { FirebaseAuthConfig } from '../config'
import { firebaseToAuthUser } from './mapUser'
import type { AuthUser, DashboardAuthProvider, SignInOptions } from '../types'

/**
 * The Firebase implementation of the auth seam.
 *
 * Everything Firebase-shaped in the dashboard is in this file and its two siblings, and the
 * whole module is reached through a dynamic `import()` from `../index.ts`, so a build with
 * `VITE_AUTH_PROVIDER=oidc` never loads it — and, thanks to the build-time branch there, never
 * even ships it.
 */
export function createFirebaseAuthProvider(config: FirebaseAuthConfig): DashboardAuthProvider {
  let app: FirebaseApp | null = null
  let auth: Auth | null = null
  let ready: Promise<void> | null = null

  function requireAuth(): Auth {
    if (!auth) throw new Error('Firebase auth provider used before init()')
    return auth
  }

  async function start(): Promise<void> {
    app = initializeApp(config.firebase)
    auth = getAuth(app)

    // Local development routes auth at the Firebase Auth emulator the docker stack runs
    // (default http://localhost:29099). Blank VITE_FIREBASE_AUTH_EMULATOR_HOST for real Firebase.
    if (config.authEmulatorHost) {
      connectAuthEmulator(auth, config.authEmulatorHost, { disableWarnings: true })
    }

    // Survive a page reload. Firebase defaults to local persistence in browsers already, but
    // stating it makes the session guarantee explicit rather than dependent on the default.
    // Outside a browser (the live auth-check script) there is no web storage, and an in-memory
    // session is the correct fallback rather than a hard failure.
    try {
      await setPersistence(auth, browserLocalPersistence)
    } catch {
      await setPersistence(auth, inMemoryPersistence)
    }
  }

  return {
    kind: 'firebase',

    init(): Promise<void> {
      ready ??= start()
      return ready
    },

    async signIn(credentials?: SignInOptions): Promise<void> {
      if (!credentials?.email || !credentials.password) {
        throw new Error('Firebase sign-in needs an email and a password')
      }
      await signInWithEmailAndPassword(requireAuth(), credentials.email.trim(), credentials.password)
    },

    async signOut(): Promise<void> {
      await signOut(requireAuth())
    },

    async getIdToken(forceRefresh = false): Promise<string | null> {
      const user = requireAuth().currentUser
      if (!user) return null
      return user.getIdToken(forceRefresh)
    },

    onAuthStateChanged(cb: (user: AuthUser | null) => void): () => void {
      return onAuthStateChanged(requireAuth(), (user) => cb(firebaseToAuthUser(user)))
    },
  }
}
