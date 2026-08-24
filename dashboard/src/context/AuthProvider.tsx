import { useCallback, useEffect, useState } from 'react'
import { onAuthStateChanged, signOut as firebaseSignOut, type User as FirebaseUser } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { getMe } from '@/lib/orgsApi'
import { errorMessage } from '@/lib/apiClient'
import type { User } from '@/types/api'
import { AuthContext } from './authContext'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null)
  const [profile, setProfile] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [profileError, setProfileError] = useState<string | null>(null)

  const loadProfile = useCallback(async () => {
    setProfileError(null)
    try {
      setProfile(await getMe())
    } catch (err) {
      setProfile(null)
      setProfileError(errorMessage(err, 'Could not load your Switchboard profile'))
    }
  }, [])

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user)
      if (!user) {
        setProfile(null)
        setProfileError(null)
        setLoading(false)
        return
      }
      // `/api/users/me` auto-provisions the Switchboard user on first sign-in, so this
      // doubles as the account bootstrap.
      void loadProfile().finally(() => setLoading(false))
    })
  }, [loadProfile])

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth)
  }, [])

  return (
    <AuthContext.Provider
      value={{ firebaseUser, profile, loading, profileError, reloadProfile: loadProfile, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}
