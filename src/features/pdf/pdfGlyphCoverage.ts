/**
 * Glyph coverage checks for PDF text edits (platform neutral).
 *
 * PIE never claims an edit succeeded when the PDF font cannot actually draw the text:
 * - Inserted text uses PDFium's standard 14 fonts (WinAnsiEncoding): only printable ASCII,
 *   Latin-1 and the Windows-1252 extras are drawable. CJK, most non-Latin scripts and emoji
 *   are not; such inserts are refused.
 * - Replacements reuse the original font; the native layer checks each new character against
 *   that font's glyphs (pdfium_bridge.cpp findMissingGlyphs). Here we reject what no PDF
 *   font path in PIE can draw: supplementary-plane characters (emoji etc.) and control
 *   characters (including newlines, which a single PDF text object cannot represent).
 *
 * Mirrors pie::isWinAnsiEncodable in android/app/src/main/cpp/pdfium/pie_bridge_core.h.
 */
import { PdfUnsupportedGlyphsError } from '../../errors';

const WIN_ANSI_EXTRAS = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

export function isWinAnsiEncodable(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;
  return WIN_ANSI_EXTRAS.has(codePoint);
}

function distinctChars(text: string, predicate: (cp: number) => boolean): string[] {
  const out: string[] = [];
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (predicate(cp) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

/** Characters the standard 14 fonts (used for inserted text) cannot draw. */
export function findUnsupportedStandardFontChars(text: string): string[] {
  return distinctChars(text, (cp) => !isWinAnsiEncodable(cp));
}

/** Characters no PIE PDF text path can draw in any font (emoji/supplementary, controls). */
export function findUndrawableChars(text: string): string[] {
  return distinctChars(text, (cp) => cp > 0xffff || cp < 0x20 || cp === 0x7f || cp === 0xfffd);
}

/** "'é' (U+00E9), '😀' (U+1F600)" for messages. */
export function describeChars(chars: readonly string[], limit = 6): string {
  const parts = chars.slice(0, limit).map((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    const hex = `U+${cp.toString(16).toUpperCase().padStart(cp > 0xffff ? 5 : 4, '0')}`;
    return cp >= 0x20 && cp !== 0x7f ? `'${ch}' (${hex})` : `(${hex})`;
  });
  return chars.length > limit ? `${parts.join(', ')}, …` : parts.join(', ');
}

/** Throws PdfUnsupportedGlyphsError when inserted text uses characters standard fonts lack. */
export function assertInsertableText(text: string): void {
  const unsupported = findUnsupportedStandardFontChars(text);
  if (unsupported.length > 0) {
    throw new PdfUnsupportedGlyphsError(
      `The standard PDF fonts used for added text cannot display ${describeChars(unsupported)}. ` +
        'Use Latin characters, or edit the PDF in an app that can embed fonts for this script.',
      unsupported,
    );
  }
}

/** Throws PdfUnsupportedGlyphsError when replacement text contains undrawable characters. */
export function assertReplaceableText(text: string): void {
  const unsupported = findUndrawableChars(text);
  if (unsupported.length > 0) {
    throw new PdfUnsupportedGlyphsError(
      `PDF text cannot display ${describeChars(unsupported)}. The text was not changed.`,
      unsupported,
    );
  }
}

/** Native failure messages use this prefix for missing glyphs (pie::kUnsupportedGlyphsPrefix). */
export const NATIVE_UNSUPPORTED_GLYPHS_PREFIX = 'UNSUPPORTED_GLYPHS: ';

/** Maps a native command error to PdfUnsupportedGlyphsError when it reports missing glyphs. */
export function unsupportedGlyphsErrorFromNative(message: string | undefined): PdfUnsupportedGlyphsError | null {
  if (!message || !message.startsWith(NATIVE_UNSUPPORTED_GLYPHS_PREFIX)) return null;
  const text = message.substring(NATIVE_UNSUPPORTED_GLYPHS_PREFIX.length);
  const chars = Array.from(text.matchAll(/'([^']+)' \(U\+[0-9A-F]+\)/g)).map((m) => m[1]);
  return new PdfUnsupportedGlyphsError(text, chars);
}
