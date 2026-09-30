import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  initAuth,
  readAuthConfig,
  requireAuthProvider,
  type AuthConfig,
  type AuthUser,
  type DashboardAuthProvider,
  type SignInOptions,
} from '@/auth'
import { getMe } from '@/lib/orgsApi'
import { errorMessage } from '@/lib/apiClient'
import type { User } from '@/types/api'
import { AuthContext } from './authContext'

/** Reading config is synchronous and cheap; a bad one is reported instead of thrown at render. */
function describeConfig(): { config: AuthConfig | null; error: string | null } {
  try {
    return { config: readAuthConfig(), error: null }
  } catch (err) {
    return { config: null, error: errorMessage(err, 'Auth is not configured correctly.') }
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [{ config, error: configError }] = useState(describeConfig)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [provider, setProvider] = useState<DashboardAuthProvider | null>(null)
  const [profile, setProfile] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(configError)

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
    if (!config) {
      setLoading(false)
      return
    }
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    initAuth()
      .then((active) => {
        if (cancelled) return
        setProvider(active)
        unsubscribe = active.onAuthStateChanged((next) => {
          setUser(next)
          if (!next) {
            setProfile(null)
            setProfileError(null)
            setLoading(false)
            return
          }
          // `/api/users/me` auto-provisions the Switchboard user on first sign-in, so this
          // doubles as the account bootstrap.
          void loadProfile().finally(() => setLoading(false))
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setAuthError(errorMessage(err, 'Could not start authentication.'))
        setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [config, loadProfile])

  const signIn = useCallback(async (credentials?: SignInOptions) => {
    const provider = await requireAuthProvider()
    await provider.signIn(credentials)
  }, [])

  const signOut = useCallback(async () => {
    const provider = await requireAuthProvider()
    await provider.signOut()
  }, [])

  const sendEmailVerification = useMemo(
    () =>
      provider?.sendEmailVerification
        ? () => provider.sendEmailVerification!()
        : undefined,
    [provider],
  )

  const refreshToken = useMemo(
    () =>
      provider?.refreshToken
        ? async () => {
            const fresh = await provider.refreshToken!()
            if (fresh) setUser(fresh)
          }
        : undefined,
    [provider],
  )

  const value = useMemo(
    () => ({
      user,
      providerKind: config?.kind ?? 'firebase',
      providerName: config?.providerName ?? 'Firebase',
      usingAuthEmulator: config?.kind === 'firebase' && Boolean(config.authEmulatorHost),
      profile,
      loading,
      profileError,
      authError,
      emailVerified: user?.emailVerified ?? null,
      sendEmailVerification,
      refreshToken,
      signIn,
      reloadProfile: loadProfile,
      signOut,
    }),
    [
      user,
      config,
      profile,
      loading,
      profileError,
      authError,
      sendEmailVerification,
      refreshToken,
      signIn,
      loadProfile,
      signOut,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
