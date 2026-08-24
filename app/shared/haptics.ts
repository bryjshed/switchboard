import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export type HapticKind = 'selection' | 'light' | 'success' | 'warning';

/**
 * Fire-and-forget haptics. Never awaited, never throws — a missing haptic
 * engine (simulator, Android without vibrator) must not break interactions.
 */
export function haptic(kind: HapticKind): void {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  try {
    let p: Promise<void>;
    switch (kind) {
      case 'selection':
        p = Haptics.selectionAsync();
        break;
      case 'light':
        p = Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        break;
      case 'success':
        p = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      case 'warning':
        p = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;
    }
    p.catch(() => {});
  } catch {
    // ignore — haptics are decoration
  }
}
