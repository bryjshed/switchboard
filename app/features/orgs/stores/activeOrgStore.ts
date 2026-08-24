import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '@shared/storage';

import { DEFAULT_ENV_KEY } from '@shared/lib/env';

interface ActiveOrgState {
  activeOrgId: string | null;
  activeProjectId: string | null;
  /** Env selection, shared by the flags list and detail screens. */
  activeEnvKey: string;
  setActiveOrg: (orgId: string | null) => void;
  setActiveProject: (projectId: string | null) => void;
  setActiveEnvKey: (envKey: string) => void;
  reset: () => void;
}

/** Persisted org/project/env selection. Cleared on sign-out via reset(). */
export const useActiveOrgStore = create<ActiveOrgState>()(
  persist(
    (set) => ({
      activeOrgId: null,
      activeProjectId: null,
      activeEnvKey: DEFAULT_ENV_KEY,
      // Switching orgs invalidates the project (and therefore its envs).
      setActiveOrg: (activeOrgId) =>
        set((s) =>
          s.activeOrgId === activeOrgId ? s : { activeOrgId, activeProjectId: null },
        ),
      setActiveProject: (activeProjectId) => set({ activeProjectId }),
      setActiveEnvKey: (activeEnvKey) => set({ activeEnvKey }),
      reset: () =>
        set({ activeOrgId: null, activeProjectId: null, activeEnvKey: DEFAULT_ENV_KEY }),
    }),
    {
      name: 'active-org',
      storage: createJSONStorage(() => mmkvStateStorage),
    },
  ),
);
