/**
 * Haptic feedback (iOS UIFeedbackGenerator / Android View haptics, no permission needed),
 * routed through the project-owned PieAppModule. A no-op when the module is missing or the
 * user turned haptics off in Settings.
 */
import { NativeModules } from 'react-native';
import { appSettings } from '../settings/appSettings';

export type HapticKind = 'selection' | 'light' | 'medium' | 'success' | 'warning' | 'error';

export function haptic(kind: HapticKind = 'light'): void {
  if (!appSettings.get().haptics) return;
  const mod = NativeModules.PieAppModule;
  if (!mod || typeof mod.haptic !== 'function') return;
  try {
    const result = mod.haptic(kind);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Haptics are best-effort.
  }
}
