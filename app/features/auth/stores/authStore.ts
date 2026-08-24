import { create } from 'zustand';

import { api, setTokenProvider, setUnauthorizedHandler, ApiClientError } from '@shared/api/client';
import type { UserResponse } from '@shared/api/types';
import { storage } from '@shared/storage';
import { useActiveOrgStore } from '@features/orgs/stores/activeOrgStore';

import { emulatorSignIn, emulatorSignUp } from '../services/authService';
import type { AuthStatus } from '../types';

const TOKEN_KEY = 'auth.idToken';

interface AuthState {
  status: AuthStatus;
  user: UserResponse | null;
  idToken: string | null;
  /** Restore the persisted session at launch. */
  bootstrap: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

/**
 * Session store over the local-first auth bridge (see services/authService).
 * The idToken lives in MMKV so relaunches stay signed in. Emulator tokens are
 * unsigned and short-lived; there is no silent refresh — a 401 from the API
 * drops the session and the gate returns to login ("refresh by re-login").
 */
export const useAuthStore = create<AuthState>()((set, get) => ({
  status: 'loading',
  user: null,
  idToken: storage.getString(TOKEN_KEY) ?? null,

  bootstrap: async () => {
    const token = get().idToken;
    if (!token) {
      set({ status: 'unauthenticated' });
      return;
    }
    try {
      const user = await api.get<UserResponse>('/api/users/me');
      set({ status: 'authenticated', user });
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 401) {
        // Stale/expired emulator token — the 401 handler below already
        // cleared the session; nothing more to do.
        return;
      }
      // Network/backend failure with a stored token: keep the session
      // (never demote on a failed fetch) — the /me query will retry.
      set({ status: 'authenticated' });
    }
  },

  signIn: async (email, password) => {
    const session = await emulatorSignIn(email, password);
    storage.set(TOKEN_KEY, session.idToken);
    set({ idToken: session.idToken });
    try {
      const user = await api.get<UserResponse>('/api/users/me');
      set({ status: 'authenticated', user });
    } catch (e) {
      // Roll back the half-open session, then rethrow — callers surface it.
      storage.remove(TOKEN_KEY);
      set({ status: 'unauthenticated', user: null, idToken: null });
      throw e;
    }
  },

  signUp: async (email, password) => {
    const session = await emulatorSignUp(email, password);
    storage.set(TOKEN_KEY, session.idToken);
    set({ idToken: session.idToken });
    try {
      // Auto-provisions the backend user on first call.
      const user = await api.get<UserResponse>('/api/users/me');
      set({ status: 'authenticated', user });
    } catch (e) {
      storage.remove(TOKEN_KEY);
      set({ status: 'unauthenticated', user: null, idToken: null });
      throw e;
    }
  },

  signOut: () => {
    storage.remove(TOKEN_KEY);
    // Drop the persisted org/project/env selection too: a 401 sign-out must not
    // leave the next account pointing at the previous one's project.
    useActiveOrgStore.getState().reset();
    set({ status: 'unauthenticated', user: null, idToken: null });
  },
}));

// Wire the api client to this store (registered here to avoid import cycles).
setTokenProvider(() => useAuthStore.getState().idToken);
setUnauthorizedHandler(() => {
  // Emulator tokens can't be refreshed silently — drop to login.
  const { status } = useAuthStore.getState();
  if (status !== 'unauthenticated') useAuthStore.getState().signOut();
});
