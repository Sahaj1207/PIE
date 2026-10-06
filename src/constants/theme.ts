import { Platform } from 'react-native';

/**
 * iOS-style design system: semantic colors (light + dark), typography, spacing and radii.
 *
 * Screens read the active palette through `useTheme()` (src/ui/ThemeProvider.tsx). The
 * static `colors.light` / `colors.dark` palettes remain exported for non-React code and
 * existing callers.
 */

export interface ThemeColors {
  // Legacy tokens (kept: existing components and tests use them)
  readonly background: string;
  readonly surface: string;
  readonly surfaceElevated: string;
  readonly surfaceSecondary: string;
  readonly border: string;
  readonly borderSubtle: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly primary: string;
  readonly primaryHover: string;
  readonly primarySubtle: string;
  readonly accent: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly destructive: string;
  readonly canvasBackground: string;
  readonly canvasPage: string;
  readonly canvasShadow: string;
  // iOS semantic tokens
  /** systemGroupedBackground */
  readonly groupedBackground: string;
  /** secondarySystemGroupedBackground (cells on grouped background) */
  readonly cell: string;
  /** Highlighted cell / pressed state */
  readonly cellPressed: string;
  /** separator */
  readonly separator: string;
  /** systemFill family (controls, chips, search field) */
  readonly fill: string;
  readonly fillSecondary: string;
  readonly fillTertiary: string;
  /** Translucent bar background (navigation/tool bars) */
  readonly bar: string;
  /** Modal dimming */
  readonly overlay: string;
  /** Text/icons on a tinted (primary) background */
  readonly onPrimary: string;
  readonly dangerSubtle: string;
  readonly successSubtle: string;
  readonly warningSubtle: string;
  /** Document-type tints */
  readonly pdfTint: string;
  readonly imageTint: string;
  /** Selection highlight on canvases */
  readonly selection: string;
  readonly selectionFill: string;
  readonly hud: string;
  readonly onHud: string;
}

export const colors: { light: ThemeColors; dark: ThemeColors } = {
  light: {
    background: '#F2F2F7',
    surface: '#FFFFFF',
    surfaceElevated: '#FFFFFF',
    surfaceSecondary: '#F9F9FB',
    border: '#E5E5EA',
    borderSubtle: '#EEEEF2',
    textPrimary: '#1C1C1E',
    textSecondary: '#6C6C70',
    textMuted: '#8E8E93',
    primary: '#007AFF',
    primaryHover: '#0062CC',
    primarySubtle: '#F0F6FF',
    accent: '#0A84FF',
    success: '#34C759',
    warning: '#FF9500',
    danger: '#FF3B30',
    destructive: '#FF3B30',
    canvasBackground: '#E5E5EA',
    canvasPage: '#FFFFFF',
    canvasShadow: 'rgba(0, 0, 0, 0.08)',
    groupedBackground: '#F2F2F7',
    cell: '#FFFFFF',
    cellPressed: '#E5E5EA',
    separator: 'rgba(60, 60, 67, 0.29)',
    fill: 'rgba(120, 120, 128, 0.2)',
    fillSecondary: 'rgba(120, 120, 128, 0.16)',
    fillTertiary: 'rgba(118, 118, 128, 0.12)',
    bar: 'rgba(249, 249, 249, 0.94)',
    overlay: 'rgba(0, 0, 0, 0.4)',
    onPrimary: '#FFFFFF',
    dangerSubtle: '#FFEBEA',
    successSubtle: '#EAF9EE',
    warningSubtle: '#FFF4E5',
    pdfTint: '#FF3B30',
    imageTint: '#34C759',
    selection: '#007AFF',
    selectionFill: 'rgba(0, 122, 255, 0.14)',
    hud: 'rgba(30, 30, 30, 0.92)',
    onHud: '#FFFFFF',
  },
  dark: {
    background: '#000000',
    surface: '#1C1C1E',
    surfaceElevated: '#2C2C2E',
    surfaceSecondary: '#2C2C2E',
    border: '#38383A',
    borderSubtle: '#2C2C2E',
    textPrimary: '#FFFFFF',
    textSecondary: '#AEAEB2',
    textMuted: '#8E8E93',
    primary: '#0A84FF',
    primaryHover: '#409CFF',
    primarySubtle: '#0B2A4A',
    accent: '#64D2FF',
    success: '#30D158',
    warning: '#FF9F0A',
    danger: '#FF453A',
    destructive: '#FF453A',
    canvasBackground: '#111113',
    canvasPage: '#2C2C2E',
    canvasShadow: 'rgba(0, 0, 0, 0.35)',
    groupedBackground: '#000000',
    cell: '#1C1C1E',
    cellPressed: '#3A3A3C',
    separator: 'rgba(84, 84, 88, 0.6)',
    fill: 'rgba(120, 120, 128, 0.36)',
    fillSecondary: 'rgba(120, 120, 128, 0.32)',
    fillTertiary: 'rgba(118, 118, 128, 0.24)',
    bar: 'rgba(22, 22, 24, 0.94)',
    overlay: 'rgba(0, 0, 0, 0.6)',
    onPrimary: '#FFFFFF',
    dangerSubtle: '#3A1210',
    successSubtle: '#0E2E16',
    warningSubtle: '#3A2706',
    pdfTint: '#FF453A',
    imageTint: '#30D158',
    selection: '#0A84FF',
    selectionFill: 'rgba(10, 132, 255, 0.22)',
    hud: 'rgba(58, 58, 60, 0.94)',
    onHud: '#FFFFFF',
  },
};

/**
 * Font weights. The platform system font is used everywhere (San Francisco on iOS, Roboto on
 * Android). Roboto has no true semibold: `600` falls back to Bold, which made Android text look
 * heavy, so the "semibold" role maps to Roboto Medium (500) there.
 */
export const fontWeights = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: (Platform.OS === 'ios' ? '600' : '500') as '600' | '500',
  bold: '700' as const,
};

/**
 * Tracking. The negative values are San Francisco's optical tracking at text sizes; applied to
 * Roboto they only crowd the glyphs, so other platforms use the font's own spacing.
 */
const track = (sf: number): number => (Platform.OS === 'ios' ? sf : 0);

/**
 * Type scale: iOS text styles, calibrated one step tighter for productivity screens (Roboto
 * renders slightly larger than SF at the same size). Every text role in the app comes from here;
 * touch targets are sized independently (MIN_TOUCH_TARGET).
 */
export const typography = {
  /** Library / Settings large title */
  largeTitle: { fontSize: 30, fontWeight: fontWeights.bold, lineHeight: 36, letterSpacing: track(0.37) },
  /** Onboarding / hero titles */
  titleLarge: { fontSize: 24, fontWeight: fontWeights.bold, lineHeight: 30, letterSpacing: track(0.35) },
  /** Section titles ("Recents"), empty-state titles */
  titleMedium: { fontSize: 18, fontWeight: fontWeights.semibold, lineHeight: 23, letterSpacing: track(0.38) },
  /** Navigation-bar titles, sheet titles, alert titles */
  headline: { fontSize: 16, fontWeight: fontWeights.semibold, lineHeight: 21, letterSpacing: track(-0.41) },
  titleSmall: { fontSize: 15, fontWeight: fontWeights.semibold, lineHeight: 20, letterSpacing: track(-0.24) },
  /** Primary body text, list rows, bar buttons */
  bodyLarge: { fontSize: 16, fontWeight: fontWeights.regular, lineHeight: 21, letterSpacing: track(-0.41) },
  /** Secondary body text, inputs in compact panels */
  bodyMedium: { fontSize: 15, fontWeight: fontWeights.regular, lineHeight: 20, letterSpacing: track(-0.24) },
  /** Edit menus, chips, compact controls */
  subhead: { fontSize: 14, fontWeight: fontWeights.regular, lineHeight: 19, letterSpacing: track(-0.15) },
  footnote: { fontSize: 13, fontWeight: fontWeights.regular, lineHeight: 18, letterSpacing: track(-0.08) },
  /** Metadata, hints, captions */
  caption: { fontSize: 12, fontWeight: fontWeights.regular, lineHeight: 16, letterSpacing: track(0) },
  /** Toolbar labels, badges, nav subtitles */
  caption2: { fontSize: 11, fontWeight: fontWeights.regular, lineHeight: 13, letterSpacing: track(0.07) },
  /** Grouped-section headers (uppercase) */
  sectionHeader: { fontSize: 12, fontWeight: fontWeights.regular, lineHeight: 16, letterSpacing: 0.3 },
  mono: { fontSize: 13, fontWeight: fontWeights.medium, lineHeight: 18 },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 36,
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  xxl: 24,
  full: 9999,
};

/** Standard iOS hit target (points). */
export const MIN_TOUCH_TARGET = 44;
