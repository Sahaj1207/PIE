/**
 * Added PDF text as a "text box" (the PDF counterpart of the image editor's added-text layers).
 *
 * While being placed, a text box is a draft: text + style + a display-space origin that the
 * user drags and pinches. On Done it is written into the page as standard-14 font text objects,
 * one per line, in ONE native batch (one undo step). Text that PIE added (standard, non-embedded
 * fonts) can later be moved / resized the same way: the draft is rebuilt from the object and the
 * batch deletes the original and inserts the new text, again verified on reopen.
 *
 * Geometry is in display-space document points (top-left origin), like PdfTextObject.bounds.
 * Widths use the standard-14 font metrics (Adobe AFM widths, 1/1000 em) so alignment and the
 * placement box match what PDFium draws.
 */
import type { PdfDisplayMatrix, PdfRect, PdfTextFormatOptions, PdfTextObject } from './types';
import { userToDisplayPoint } from './pdfPageGeometry';
import { findUnsupportedStandardFontChars } from './pdfGlyphCoverage';

export type PdfStandardFamily = 'Helvetica' | 'Times-Roman' | 'Courier';
export type PdfTextAlignment = 'left' | 'center' | 'right';

export interface PdfTextBoxStyle {
  readonly fontFamily: PdfStandardFamily;
  readonly fontSize: number;
  readonly isBold: boolean;
  readonly isItalic: boolean;
  readonly color: string;
  readonly alignment: PdfTextAlignment;
}

export interface PdfTextBoxDraft {
  readonly text: string;
  readonly style: PdfTextBoxStyle;
  /** Display-space top-left of the box (document points). */
  readonly origin: { readonly x: number; readonly y: number };
}

export interface PdfTextBoxLine {
  readonly text: string;
  /** Top-left of the line box (display space). The baseline is at y + fontSize. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

export const PDF_TEXT_BOX_LINE_HEIGHT = 1.2;
export const PDF_TEXT_BOX_MIN_SIZE = 6;
export const PDF_TEXT_BOX_MAX_SIZE = 96;

export const DEFAULT_PDF_TEXT_STYLE: PdfTextBoxStyle = {
  fontFamily: 'Helvetica',
  fontSize: 14,
  isBold: false,
  isItalic: false,
  color: '#000000',
  alignment: 'left',
};

/**
 * Standard-14 family for any UI or PDF family name. Note "sans-serif" contains "serif": it is
 * Helvetica, never Times.
 */
export function standardFontFamily(family?: string | null): PdfStandardFamily {
  const f = (family || '').toLowerCase().replace(/^[a-z]{6}\+/, '');
  if (f.includes('courier') || f.includes('mono')) return 'Courier';
  if (f.includes('times') || f.includes('roman') || (f.includes('serif') && !f.includes('sans'))) return 'Times-Roman';
  return 'Helvetica';
}

/** UI font family (Edit Text panel) for a standard family. */
export function uiFamilyOf(family: PdfStandardFamily): 'sans-serif' | 'serif' | 'monospace' {
  return family === 'Times-Roman' ? 'serif' : family === 'Courier' ? 'monospace' : 'sans-serif';
}

/** Format options sent to the editor (standard family names only). */
export function textBoxFormat(style: PdfTextBoxStyle): PdfTextFormatOptions {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    isBold: style.isBold,
    isItalic: style.isItalic,
    color: style.color,
  };
}

// ---------------------------------------------------------------------------
// Standard-14 metrics (printable ASCII 32..126; other WinAnsi characters use the average)
// ---------------------------------------------------------------------------

// prettier-ignore
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// prettier-ignore
const HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
// prettier-ignore
const TIMES = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541];
// prettier-ignore
const TIMES_BOLD = [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520];

function charWidths(family: PdfStandardFamily, bold: boolean): readonly number[] | null {
  if (family === 'Courier') return null; // monospaced: 600 everywhere
  if (family === 'Times-Roman') return bold ? TIMES_BOLD : TIMES;
  return bold ? HELVETICA_BOLD : HELVETICA;
}

/** Advance width of `text` (points) in a standard-14 font. */
export function standardTextWidth(text: string, family: PdfStandardFamily, fontSize: number, bold = false): number {
  const widths = charWidths(family, bold);
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    if (!widths) units += 600;
    else units += code >= 32 && code <= 126 ? widths[code - 32] : 556;
  }
  return (units / 1000) * fontSize;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Lines of the box (explicit newlines; trailing blank space removed per line). */
export function textBoxLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/u, ''));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  return lines;
}

export function layoutPdfTextBox(draft: PdfTextBoxDraft): {
  lines: PdfTextBoxLine[];
  width: number;
  height: number;
  lineHeight: number;
} {
  const { style, origin } = draft;
  const lineHeight = style.fontSize * PDF_TEXT_BOX_LINE_HEIGHT;
  const raw = textBoxLines(draft.text);
  const measured = raw.map((t) => ({ t, w: standardTextWidth(t, style.fontFamily, style.fontSize, style.isBold) }));
  const width = Math.max(style.fontSize, ...measured.map((m) => m.w));
  const lines = measured.map((m, i) => {
    const offset = style.alignment === 'center' ? (width - m.w) / 2 : style.alignment === 'right' ? width - m.w : 0;
    return { text: m.t, x: origin.x + offset, y: origin.y + i * lineHeight, width: m.w };
  });
  const count = Math.max(1, raw.length);
  return { lines, width, height: (count - 1) * lineHeight + style.fontSize * 1.25, lineHeight };
}

/** Placement box of the draft (display space). */
export function textBoxRect(draft: PdfTextBoxDraft): PdfRect {
  const { width, height } = layoutPdfTextBox(draft);
  return { x: draft.origin.x, y: draft.origin.y, width, height };
}

/**
 * Draft after a drag / pinch of its placement box: the origin follows the box and the font
 * size scales with the box height (clamped to the supported range).
 */
export function draftForRect(draft: PdfTextBoxDraft, rect: PdfRect): PdfTextBoxDraft {
  const current = textBoxRect(draft);
  const ratio = current.height > 0 ? rect.height / current.height : 1;
  const fontSize = Math.round(
    Math.min(PDF_TEXT_BOX_MAX_SIZE, Math.max(PDF_TEXT_BOX_MIN_SIZE, draft.style.fontSize * ratio)) * 2,
  ) / 2;
  return { ...draft, style: { ...draft.style, fontSize }, origin: { x: rect.x, y: rect.y } };
}

/** Keeps the draft's box on the page. */
export function clampDraftToPage(draft: PdfTextBoxDraft, page: { width: number; height: number }): PdfTextBoxDraft {
  const r = textBoxRect(draft);
  const x = Math.max(0, Math.min(Math.max(0, page.width - r.width), draft.origin.x));
  const y = Math.max(0, Math.min(Math.max(0, page.height - r.height), draft.origin.y));
  return x === draft.origin.x && y === draft.origin.y ? draft : { ...draft, origin: { x, y } };
}

/** Characters the standard fonts cannot draw (empty when the text can be added). */
export function unsupportedTextBoxChars(text: string): string[] {
  return findUnsupportedStandardFontChars(textBoxLines(text).join(''));
}

// ---------------------------------------------------------------------------
// Existing objects (move / resize text that uses a standard font)
// ---------------------------------------------------------------------------

/** Standard-14 font of an extracted object, or null (embedded / other fonts). */
export function parseStandardFont(obj: Pick<PdfTextObject, 'fontName' | 'fontDetails'>): {
  family: PdfStandardFamily;
  isBold: boolean;
  isItalic: boolean;
} | null {
  if (obj.fontDetails?.isEmbedded || obj.fontDetails?.isSubset) return null;
  const name = (obj.fontName || '').replace(/^[A-Z]{6}\+/, '');
  const m = /^(Helvetica|Arial|Times|Courier)/i.exec(name);
  if (!m) return null;
  const lower = name.toLowerCase();
  return {
    family: standardFontFamily(m[1].toLowerCase() === 'arial' ? 'Helvetica' : name),
    isBold: lower.includes('bold') || (obj.fontDetails?.weight ?? 0) >= 700,
    isItalic: lower.includes('italic') || lower.includes('oblique'),
  };
}

/**
 * True when the object can be moved/resized losslessly by re-inserting it: top-level text in a
 * standard (non-embedded) font that the standard fonts can draw, with an upright matrix.
 */
export function isMovableTextObject(obj: PdfTextObject): boolean {
  if (!obj.isEditable || !obj.text.trim()) return false;
  if (obj.objectPath && obj.objectPath.length > 1) return false;
  if (!parseStandardFont(obj)) return false;
  if (findUnsupportedStandardFontChars(obj.text).length > 0) return false;
  const m = obj.matrix;
  if (m && (Math.abs(m.b) > 1e-3 || Math.abs(m.c) > 1e-3)) return false; // rotated/skewed text
  return true;
}

/** Effective font size of an object (Tf size x matrix scale). */
export function effectiveFontSize(obj: PdfTextObject): number {
  const base = obj.fontSize && obj.fontSize > 0 ? obj.fontSize : obj.bounds.height / 1.2;
  const m = obj.matrix;
  const scale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
  return base * (scale > 0 && Number.isFinite(scale) ? scale : 1);
}

/**
 * Display-space baseline y of a top-level, upright text object (from its matrix), or null when
 * it cannot be derived reliably (nested forms, rotated text, inconsistent with the bounds).
 */
export function displayBaselineY(obj: PdfTextObject, displayMatrix: PdfDisplayMatrix | null): number | null {
  const m = obj.matrix;
  if (!m || !displayMatrix) return null;
  if (obj.objectPath && obj.objectPath.length > 1) return null;
  if (Math.abs(m.b) > 1e-3 || Math.abs(m.c) > 1e-3) return null;
  const p = userToDisplayPoint(displayMatrix, m.e, m.f);
  const { y, height } = obj.bounds;
  // The baseline must sit in the lower part of the glyph box
  if (!(p.y >= y + height * 0.4 && p.y <= y + height + 0.5)) return null;
  return p.y;
}

/** Draft that reproduces an existing standard-font object (for Move / Resize). */
export function draftFromTextObject(obj: PdfTextObject, displayMatrix: PdfDisplayMatrix | null): PdfTextBoxDraft | null {
  const font = parseStandardFont(obj);
  if (!font) return null;
  const fontSize = Math.round(effectiveFontSize(obj) * 2) / 2;
  const baseline = displayBaselineY(obj, displayMatrix);
  return {
    text: obj.text.trim(),
    style: {
      fontFamily: font.family,
      fontSize,
      isBold: font.isBold,
      isItalic: font.isItalic,
      color: (obj.color || '#000000').toUpperCase(),
      alignment: 'left',
    },
    origin: { x: obj.bounds.x, y: baseline !== null ? baseline - fontSize : obj.bounds.y },
  };
}
