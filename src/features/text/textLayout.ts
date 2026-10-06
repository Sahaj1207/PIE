/**
 * Deterministic multi-line text layout shared by the image editor's on-screen canvas and the
 * native exporter (through the image render plan). Line breaking happens ONCE, here, using a
 * single TextMeasurer; renderers only draw the resulting lines at the given coordinates, so
 * preview and export break lines identically.
 *
 * All values are in document (intrinsic image pixel) coordinates.
 */
import { resolveSystemFontFamily } from './textFitting';

/** Font families every supported renderer can provide without bundling fonts. */
export const RENDERABLE_FONT_FAMILIES = ['sans-serif', 'serif', 'monospace'] as const;
export type RenderableFontFamily = (typeof RENDERABLE_FONT_FAMILIES)[number];
export const FALLBACK_FONT_FAMILY: RenderableFontFamily = 'sans-serif';

export const DEFAULT_LINE_HEIGHT_RATIO = 1.25;

const FONT_ALIASES: Record<string, RenderableFontFamily> = {
  'sans-serif': 'sans-serif',
  sans: 'sans-serif',
  system: 'sans-serif',
  helvetica: 'sans-serif',
  arial: 'sans-serif',
  roboto: 'sans-serif',
  serif: 'serif',
  times: 'serif',
  'times new roman': 'serif',
  'times-roman': 'serif',
  georgia: 'serif',
  monospace: 'monospace',
  mono: 'monospace',
  courier: 'monospace',
  'courier new': 'monospace',
  menlo: 'monospace',
};

/**
 * Maps a requested family to one the renderers can actually provide. Unknown families fall
 * back deterministically (never silently to whatever the platform picks).
 */
export function resolveRenderableFontFamily(requested?: string | null): RenderableFontFamily {
  const clean = (requested || '').toLowerCase().trim();
  if (!clean) return FALLBACK_FONT_FAMILY;
  const alias = FONT_ALIASES[clean];
  if (alias) return alias;
  if (clean.includes('courier')) return 'monospace';
  if (clean.includes('times') || clean.includes('georgia')) return 'serif';
  return resolveSystemFontFamily(clean) as RenderableFontFamily;
}

/** Platform font name for a renderable family (Android uses the generic names directly). */
export function platformFontFamily(family: RenderableFontFamily, os: string): string {
  if (os === 'ios') {
    switch (family) {
      case 'serif':
        return 'Times New Roman';
      case 'monospace':
        return 'Courier';
      default:
        return 'Helvetica';
    }
  }
  return family;
}

export interface TextFontSpec {
  readonly fontFamily: RenderableFontFamily;
  readonly fontSize: number;
  readonly fontWeight: string;
  readonly fontStyle: 'normal' | 'italic';
}

/** Advance width of `text` (single line, no newlines) in document pixels. */
export type TextMeasurer = (text: string, font: TextFontSpec) => number;

function isBoldWeight(weight: string): boolean {
  return weight === 'bold' || (Number.parseInt(weight, 10) || 400) >= 600;
}

/**
 * Deterministic width estimate used when no real font measurement is available (tests,
 * platforms without Skia fonts). Per-character factors approximate common sans/serif
 * metrics; monospace is exact by definition (0.6 em).
 */
export function estimateTextWidth(text: string, font: TextFontSpec): number {
  const size = Math.max(0, font.fontSize);
  let em = 0;
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (font.fontFamily === 'monospace') {
      em += cp >= 0x2e80 ? 1.0 : 0.6;
      continue;
    }
    if (ch === ' ') em += 0.28;
    else if ('iljI.,:;\'|!`'.includes(ch)) em += 0.28;
    else if ('frt()[]{}-'.includes(ch)) em += 0.36;
    else if ('mwMW@%'.includes(ch)) em += 0.86;
    else if (ch >= '0' && ch <= '9') em += 0.56;
    else if (ch >= 'A' && ch <= 'Z') em += 0.66;
    else if (cp >= 0x2e80) em += 1.0; // CJK, emoji and other wide glyphs
    else em += 0.52;
  }
  const weightFactor = isBoldWeight(font.fontWeight) ? 1.06 : 1;
  return em * size * weightFactor;
}

export interface TextLayoutLine {
  readonly text: string;
  readonly width: number;
}

export interface TextBlockLayout {
  readonly lines: TextLayoutLine[];
  /** Width of the widest line. */
  readonly width: number;
  /** lines.length * lineHeight */
  readonly height: number;
  readonly lineHeight: number;
}

export interface TextLayoutOptions {
  /** Line advance in document pixels (default fontSize * 1.25). */
  readonly lineHeight?: number;
  /** Wrap width; lines are only broken at explicit newlines when omitted. */
  readonly maxWidth?: number;
  readonly measure?: TextMeasurer;
}

function safeMeasure(measure: TextMeasurer, text: string, font: TextFontSpec): number {
  const w = measure(text, font);
  return Number.isFinite(w) && w >= 0 ? w : estimateTextWidth(text, font);
}

/** Breaks a word that is wider than maxWidth into chunks (at least one character each). */
function breakLongWord(word: string, font: TextFontSpec, maxWidth: number, measure: TextMeasurer): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const ch of Array.from(word)) {
    const candidate = current + ch;
    if (current && safeMeasure(measure, candidate, font) > maxWidth) {
      chunks.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function wrapParagraph(paragraph: string, font: TextFontSpec, maxWidth: number, measure: TextMeasurer): string[] {
  if (safeMeasure(measure, paragraph, font) <= maxWidth) return [paragraph];
  const tokens = paragraph.split(/(\s+)/).filter((t) => t.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    const isSpace = /^\s+$/.test(token);
    if (!current) {
      if (isSpace) continue; // never start a wrapped line with whitespace
      if (safeMeasure(measure, token, font) > maxWidth) {
        const chunks = breakLongWord(token, font, maxWidth, measure);
        lines.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1] ?? '';
      } else {
        current = token;
      }
      continue;
    }
    const candidate = current + token;
    if (isSpace || safeMeasure(measure, candidate.trimEnd(), font) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current.trimEnd());
      if (safeMeasure(measure, token, font) > maxWidth) {
        const chunks = breakLongWord(token, font, maxWidth, measure);
        lines.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1] ?? '';
      } else {
        current = token;
      }
    }
  }
  if (current.trim().length > 0 || lines.length === 0) lines.push(current.trimEnd());
  return lines;
}

/**
 * Lays out multi-line text: explicit newlines are always preserved (an empty line stays an
 * empty line); with maxWidth, paragraphs wrap greedily at whitespace, and words wider than
 * maxWidth are broken by character. Deterministic for a given measurer.
 */
export function layoutTextBlock(text: string, font: TextFontSpec, options: TextLayoutOptions = {}): TextBlockLayout {
  const measure = options.measure ?? estimateTextWidth;
  const lineHeight =
    options.lineHeight && options.lineHeight > 0 ? options.lineHeight : font.fontSize * DEFAULT_LINE_HEIGHT_RATIO;
  const maxWidth = options.maxWidth && options.maxWidth > 0 ? options.maxWidth : undefined;

  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  const lineTexts: string[] = [];
  for (const paragraph of paragraphs) {
    if (maxWidth === undefined) {
      lineTexts.push(paragraph);
    } else {
      lineTexts.push(...wrapParagraph(paragraph, font, maxWidth, measure));
    }
  }

  const lines = lineTexts.map((t) => ({ text: t, width: t ? safeMeasure(measure, t, font) : 0 }));
  const width = lines.reduce((max, l) => Math.max(max, l.width), 0);
  return { lines, width, height: lines.length * lineHeight, lineHeight };
}
