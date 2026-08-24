/**
 * Jest environment shims.
 * - reanimated: official mock, extended with useReducedMotion (marked
 *   "ADD ME IF NEEDED" upstream) so motion-gated components render.
 * - expo-haptics: no native haptic engine in jest.
 * - react-native-mmkv v4 auto-mocks itself under JEST_WORKER_ID (in-memory).
 */
jest.mock('react-native-worklets', () =>
  require('react-native-worklets/lib/module/mock'),
);

jest.mock('react-native-reanimated', () => {
  const mock = require('react-native-reanimated/mock');
  return {
    ...mock,
    useReducedMotion: () => false,
  };
});

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy', Rigid: 'rigid', Soft: 'soft' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('react-native-mmkv', () => {
  // The real module eagerly imports NitroModules (native-only) before its own
  // isTest() gate can run; use the library's in-memory mock directly.
  const {
    createMockMMKV,
  } = require('react-native-mmkv/lib/createMMKV/createMockMMKV');
  return { createMMKV: createMockMMKV };
});
