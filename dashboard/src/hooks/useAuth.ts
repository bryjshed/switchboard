import { useContext } from 'react'
import { AuthContext, type AuthState } from '@/context/authContext'

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
