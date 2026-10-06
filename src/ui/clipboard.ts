/** Clipboard and plain-text sharing through the project-owned PieAppModule. */
import { NativeModules } from 'react-native';

export async function copyText(text: string): Promise<boolean> {
  const mod = NativeModules.PieAppModule;
  if (!mod || typeof mod.setClipboardString !== 'function') return false;
  try {
    await mod.setClipboardString(text);
    return true;
  } catch {
    return false;
  }
}

export async function shareText(text: string, title = 'Share Text'): Promise<boolean> {
  const mod = NativeModules.PieAppModule;
  if (!mod || typeof mod.shareText !== 'function') return false;
  try {
    await mod.shareText(text, title);
    return true;
  } catch {
    return false;
  }
}
