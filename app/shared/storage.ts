import { createMMKV, type MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

/**
 * Single app-wide MMKV instance. Synchronous, so persisted zustand stores
 * (theme mode, auth token, active org/project) hydrate at launch with no
 * async flash. Auto-mocked in jest (react-native-mmkv v4 returns an in-memory mock under JEST_WORKER_ID).
 */
export const storage: MMKV = createMMKV({ id: 'switchboard' });

/** zustand persist adapter over MMKV. */
export const mmkvStateStorage: StateStorage = {
  getItem: (name) => storage.getString(name) ?? null,
  setItem: (name, value) => storage.set(name, value),
  removeItem: (name) => storage.remove(name),
};
