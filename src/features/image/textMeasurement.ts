/**
 * Text measurement for the image editor's shared render plan.
 *
 * In the app, widths come from the same Skia fonts the canvas draws with (matchFont), so line
 * breaking and alignment are based on real glyph advances. The SAME measurer instance is used
 * when building the plan for the canvas and for export, so both receive identical lines.
 * In Jest (or if Skia fonts are unavailable) a deterministic estimate is used instead.
 */
import { Platform } from 'react-native';
import {
  TextFontSpec,
  TextMeasurer,
  estimateTextWidth,
  platformFontFamily,
} from '../text/textLayout';

// Same local declaration as HomeScreen: `process` is not guaranteed by the RN type config.
declare const process: any;

function isTestEnvironment(): boolean {
  return typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test';
}

export function createPlatformTextMeasurer(): TextMeasurer {
  if (isTestEnvironment()) {
    return estimateTextWidth;
  }

  let skia: { matchFont?: (desc: object) => any } | null | undefined;
  const fonts = new Map<string, any>();

  const loadSkia = () => {
    if (skia === undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        skia = require('@shopify/react-native-skia');
      } catch {
        skia = null;
      }
    }
    return skia;
  };

  const fontFor = (font: TextFontSpec): any => {
    const key = `${font.fontFamily}|${font.fontSize}|${font.fontWeight}|${font.fontStyle}`;
    if (fonts.has(key)) return fonts.get(key);
    let resolved: any = null;
    const lib = loadSkia();
    if (lib && typeof lib.matchFont === 'function') {
      try {
        resolved = lib.matchFont({
          fontFamily: platformFontFamily(font.fontFamily, Platform.OS),
          fontSize: font.fontSize,
          fontWeight: font.fontWeight,
          fontStyle: font.fontStyle,
        });
      } catch {
        resolved = null;
      }
    }
    fonts.set(key, resolved);
    return resolved;
  };

  return (text: string, font: TextFontSpec): number => {
    const skFont = fontFor(font);
    if (skFont) {
      try {
        const width =
          typeof skFont.getTextWidth === 'function'
            ? skFont.getTextWidth(text)
            : skFont.measureText?.(text)?.width;
        if (typeof width === 'number' && Number.isFinite(width) && width >= 0) {
          return width;
        }
      } catch {
        // fall through to the deterministic estimate
      }
    }
    return estimateTextWidth(text, font);
  };
}

/** Shared measurer: used for the canvas, for export and for added-text bounds. */
export const defaultTextMeasurer: TextMeasurer = createPlatformTextMeasurer();
