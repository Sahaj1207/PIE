/**
 * Polished, iOS-inspired production design system.
 * Restrained typography, subtle hairlines, native spacing, and purposeful accent.
 */

export const colors = {
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
  },
  dark: {
    background: '#000000',
    surface: '#1C1C1E',
    surfaceElevated: '#2C2C2E',
    surfaceSecondary: '#2C2C2E',
    border: '#38383A',
    borderSubtle: '#2C2C2E',
    textPrimary: '#FFFFFF',
    textSecondary: '#8E8E93',
    textMuted: '#636366',
    primary: '#0A84FF',
    primaryHover: '#409CFF',
    primarySubtle: '#1C2538',
    accent: '#64D2FF',
    success: '#30D158',
    warning: '#FF9F0A',
    danger: '#FF453A',
    destructive: '#FF453A',
    canvasBackground: '#1C1C1E',
    canvasPage: '#2C2C2E',
    canvasShadow: 'rgba(0, 0, 0, 0.35)',
  },
};

export const typography = {
  titleLarge: {
    fontSize: 28,
    fontWeight: '700' as const,
    lineHeight: 34,
    letterSpacing: 0.35,
  },
  titleMedium: {
    fontSize: 20,
    fontWeight: '600' as const,
    lineHeight: 25,
    letterSpacing: 0.38,
  },
  titleSmall: {
    fontSize: 16,
    fontWeight: '600' as const,
    lineHeight: 21,
    letterSpacing: -0.32,
  },
  bodyLarge: {
    fontSize: 17,
    fontWeight: '400' as const,
    lineHeight: 22,
    letterSpacing: -0.41,
  },
  bodyMedium: {
    fontSize: 15,
    fontWeight: '400' as const,
    lineHeight: 20,
    letterSpacing: -0.24,
  },
  caption: {
    fontSize: 13,
    fontWeight: '400' as const,
    lineHeight: 18,
    letterSpacing: -0.08,
  },
  mono: {
    fontSize: 13,
    fontWeight: '500' as const,
    lineHeight: 18,
  },
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
  full: 9999,
};
