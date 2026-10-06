/**
 * Active colour palette for the app: follows the system appearance unless the user picked
 * Light or Dark in Settings. Components read it with `useTheme()`.
 */
import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { Appearance, StatusBar, useColorScheme } from 'react-native';
import { ThemeColors, colors } from '../constants/theme';
import { AppearancePreference, useAppSettings } from '../settings/appSettings';

export interface Theme {
  readonly dark: boolean;
  readonly colors: ThemeColors;
}

const LIGHT_THEME: Theme = { dark: false, colors: colors.light };
const DARK_THEME: Theme = { dark: true, colors: colors.dark };

const ThemeContext = createContext<Theme>(LIGHT_THEME);

/** Pure resolution of the effective scheme (exported for tests). */
export function resolveDarkMode(
  preference: AppearancePreference,
  system: string | null | undefined,
): boolean {
  if (preference === 'dark') return true;
  if (preference === 'light') return false;
  return system === 'dark';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const settings = useAppSettings();
  const system = useColorScheme();
  const dark = resolveDarkMode(settings.appearance, system);

  // Native UI (system dialogs, pickers, keyboard) follows the in-app choice.
  useEffect(() => {
    try {
      const setScheme = (Appearance as unknown as { setColorScheme?: (s: string | null) => void })
        .setColorScheme;
      if (typeof setScheme === 'function') {
        setScheme(settings.appearance === 'system' ? 'unspecified' : settings.appearance);
      }
    } catch {
      // Older runtimes: the in-app palette still applies.
    }
  }, [settings.appearance]);

  const theme = useMemo(() => (dark ? DARK_THEME : LIGHT_THEME), [dark]);
  return (
    <ThemeContext.Provider value={theme}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      {children}
    </ThemeContext.Provider>
  );
};

/** Current palette (light palette when rendered outside the provider, e.g. isolated tests). */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
