import React, { useState, useEffect, useRef } from 'react';
import { Platform, StyleSheet, TextInput } from 'react-native';
import { platformFontFamily } from '../../text/textLayout';
import { PdfTextObject, PdfTextFormatOptions } from '../types';
import {
  DEFAULT_PDF_TEXT_STYLE,
  PdfTextAlignment,
  PdfTextBoxStyle,
  PdfStandardFamily,
  effectiveFontSize,
  standardFontFamily,
  uiFamilyOf,
  unsupportedTextBoxChars,
} from '../pdfTextBox';
import { describeChars } from '../pdfGlyphCoverage';
import { radius, spacing, typography } from '../../../constants/theme';
import { useTheme } from '../../../ui/ThemeProvider';
import { haptic } from '../../../ui/haptics';
import {
  ChoiceSegments,
  ColorSwatches,
  EditorSheet,
  FormatGroup,
  FormatNote,
  FormatRow,
  SizeStepper,
  ToggleButton,
} from '../../../ui/formatControls';

/** Values chosen in the panel that are not part of PdfTextFormatOptions. */
export interface PdfTextEditExtras {
  /** Line alignment of added text (text boxes only). */
  readonly alignment: PdfTextAlignment;
  /** The chosen style in text-box terms (added text). */
  readonly style: PdfTextBoxStyle;
}

interface PdfTextEditModalProps {
  visible: boolean;
  targetObject: PdfTextObject | null;
  isInsertMode?: boolean;
  /** Insert mode: text and style to start from (re-editing a text box, or the last used style). */
  draft?: { readonly text: string; readonly style: PdfTextBoxStyle } | null;
  /** Edit mode: text to start from instead of the whole object (a character selection). */
  initialText?: string | null;
  /**
   * Edit mode: formatting cannot be applied (e.g. only part of a text run is selected); the
   * reason is shown and only the text is sent.
   */
  formatLockedReason?: string | null;
  onApply: (text: string, format: PdfTextFormatOptions, extras: PdfTextEditExtras) => void;
  onCancel: () => void;
}

const PRESET_SIZES = [9, 10, 11, 12, 14, 16, 18, 24, 32];
export const PDF_TEXT_COLORS = ['#000000', '#3A3A3C', '#8E8E93', '#007AFF', '#34C759', '#FF3B30', '#FF9500', '#AF52DE'];
const MIN_SIZE = 6;
const MAX_SIZE = 96;

type Family = 'sans-serif' | 'serif' | 'monospace';

const FAMILIES: readonly { value: Family; label: string; fontFamily: string }[] = [
  { value: 'sans-serif', label: 'Sans', fontFamily: platformFontFamily('sans-serif', Platform.OS) },
  { value: 'serif', label: 'Serif', fontFamily: platformFontFamily('serif', Platform.OS) },
  { value: 'monospace', label: 'Mono', fontFamily: platformFontFamily('monospace', Platform.OS) },
];

const ALIGNMENTS: readonly { value: PdfTextAlignment; icon: 'alignLeft' | 'alignCenter' | 'alignRight'; accessibilityLabel: string }[] = [
  { value: 'left', icon: 'alignLeft', accessibilityLabel: 'Align Left' },
  { value: 'center', icon: 'alignCenter', accessibilityLabel: 'Align Center' },
  { value: 'right', icon: 'alignRight', accessibilityLabel: 'Align Right' },
];

/** Family of an existing PDF font name (standard-14 aliases and common names). */
export function pdfFamilyOf(fontName: string | null | undefined): Family {
  return uiFamilyOf(standardFontFamily(fontName));
}

/** Standard PDF family sent to the editor for a panel family. */
function toStandard(family: Family): PdfStandardFamily {
  return family === 'serif' ? 'Times-Roman' : family === 'monospace' ? 'Courier' : 'Helvetica';
}

/** Readable font name: drops the subset tag ("ABCDEF+ArialMT" -> "ArialMT"). */
export function displayPdfFontName(fontName: string | null | undefined): string {
  const name = (fontName || '').trim();
  if (!name) return 'Standard font';
  return name.replace(/^[A-Z]{6}\+/, '');
}

export const PdfTextEditModal: React.FC<PdfTextEditModalProps> = ({
  visible,
  targetObject,
  isInsertMode = false,
  draft = null,
  initialText = null,
  formatLockedReason = null,
  onApply,
  onCancel,
}) => {
  const { colors } = useTheme();

  const [text, setText] = useState<string>('');
  const [fontSize, setFontSize] = useState<number>(14);
  const [fontFamily, setFontFamily] = useState<Family>('sans-serif');
  const [isBold, setIsBold] = useState<boolean>(false);
  const [isItalic, setIsItalic] = useState<boolean>(false);
  const [color, setColor] = useState<string>('#000000');
  const [alignment, setAlignment] = useState<PdfTextAlignment>('left');
  // Replacement: values the panel opened with (unchanged style is never sent, so the original
  // font is kept whenever possible)
  const [initial, setInitial] = useState<{ family: Family; bold: boolean; italic: boolean; size: number; tf: number } | null>(null);

  const isNested = Boolean(targetObject?.objectPath && targetObject.objectPath.length > 1);
  const isEmbeddedOrSubset = Boolean(
    targetObject?.fontDetails?.isSubset || targetObject?.fontDetails?.isEmbedded,
  );
  const isStyleSupported = isInsertMode || (!isNested && !isEmbeddedOrSubset);
  const formatLocked = !isInsertMode && !!formatLockedReason;

  // Initialise once each time the panel opens (never while the user is typing)
  const openedRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    if (isInsertMode) {
      const style = draft?.style ?? DEFAULT_PDF_TEXT_STYLE;
      setText(draft?.text ?? '');
      setFontSize(style.fontSize);
      setFontFamily(uiFamilyOf(style.fontFamily));
      setIsBold(style.isBold);
      setIsItalic(style.isItalic);
      setColor(style.color.toUpperCase());
      setAlignment(style.alignment);
      setInitial(null);
    } else if (targetObject) {
      const lowerFont = (targetObject.fontName || '').toLowerCase();
      const family = pdfFamilyOf(targetObject.fontName);
      const bold = lowerFont.includes('bold') || (targetObject.fontDetails?.weight ?? 0) >= 700;
      const italic = lowerFont.includes('italic') || lowerFont.includes('oblique');
      // Show the size as it appears on the page (font size x text-matrix scale)
      const visibleSize = Math.max(1, Math.round(effectiveFontSize(targetObject)));
      setText(initialText ?? targetObject.text);
      setFontSize(visibleSize);
      setFontFamily(family);
      setIsBold(bold);
      setIsItalic(italic);
      setColor((targetObject.color || '#000000').toUpperCase());
      setAlignment('left');
      setInitial({ family, bold, italic, size: visibleSize, tf: targetObject.fontSize || visibleSize });
    }
  }, [visible, targetObject, isInsertMode, draft, initialText]);

  const style: PdfTextBoxStyle = {
    fontFamily: toStandard(fontFamily),
    fontSize,
    isBold,
    isItalic,
    color,
    alignment,
  };

  const handleApply = () => {
    if (!text.trim()) return;
    haptic('light');
    if (isInsertMode) {
      // Added text keeps its lines (each line becomes one PDF text line)
      onApply(text.replace(/\s+$/u, '').replace(/^\s*\n/u, ''), {
        fontFamily: style.fontFamily,
        fontSize,
        isBold,
        isItalic,
        color,
      }, { alignment, style });
      return;
    }
    // A replacement is one text object: line breaks become spaces
    const replacement = text.replace(/\s*\n\s*/g, ' ').trim();
    if (formatLocked) {
      onApply(replacement, {}, { alignment: 'left', style });
      return;
    }
    const format: { -readonly [K in keyof PdfTextFormatOptions]: PdfTextFormatOptions[K] } = { color };
    if (initial && fontSize !== initial.size) {
      // Scale the font's own size so the visible size matches the choice
      format.fontSize = Math.max(0.5, Math.round(initial.tf * (fontSize / initial.size) * 100) / 100);
    } else if (initial) {
      format.fontSize = initial.tf;
    }
    if (isStyleSupported && initial && (fontFamily !== initial.family || isBold !== initial.bold || isItalic !== initial.italic)) {
      format.fontFamily = style.fontFamily;
      format.isBold = isBold;
      format.isItalic = isItalic;
    }
    onApply(replacement, format, { alignment: 'left', style });
  };

  const canApply = text.trim().length > 0;
  const swatches = PDF_TEXT_COLORS.includes(color.toUpperCase()) ? PDF_TEXT_COLORS : [color.toUpperCase(), ...PDF_TEXT_COLORS];
  const unsupported = isInsertMode ? unsupportedTextBoxChars(text) : [];
  const isReEdit = isInsertMode && !!draft?.text;

  return (
    <EditorSheet
      visible={visible}
      title={isInsertMode ? (isReEdit ? 'Edit Text Box' : 'Add Text') : 'Edit Text'}
      confirmLabel={isInsertMode && !isReEdit ? 'Add' : 'Done'}
      confirmDisabled={!canApply || unsupported.length > 0}
      onConfirm={handleApply}
      onCancel={onCancel}>
      <TextInput
        value={text}
        onChangeText={setText}
        style={[
          styles.textInput,
          {
            backgroundColor: colors.cell,
            color: colors.textPrimary,
            fontWeight: isStyleSupported && isBold ? '700' : '400',
            fontStyle: isStyleSupported && isItalic ? 'italic' : 'normal',
            fontFamily: isStyleSupported ? platformFontFamily(fontFamily, Platform.OS) : undefined,
            textAlign: isInsertMode ? alignment : 'left',
          },
        ]}
        placeholder={isInsertMode ? 'Type your text — new lines are kept' : 'Replacement text'}
        placeholderTextColor={colors.textMuted}
        multiline
        autoFocus
        selectTextOnFocus={!isInsertMode || isReEdit}
        accessibilityLabel="Text"
      />

      {unsupported.length > 0 && (
        <FormatNote icon="info">
          {`${describeChars(unsupported)} can't be added with the built-in PDF fonts (Latin text, digits and common symbols only).`}
        </FormatNote>
      )}

      {formatLocked && <FormatNote icon="lock">{formatLockedReason}</FormatNote>}

      {!isInsertMode && targetObject && !formatLocked && (
        <FormatNote icon={isStyleSupported ? 'info' : 'lock'}>
          {isStyleSupported
            ? `Font: ${displayPdfFontName(targetObject.fontName)}`
            : `Keeps the original ${isEmbeddedOrSubset ? 'embedded ' : ''}font (${displayPdfFontName(targetObject.fontName)}). Size and colour can change; family and bold/italic can't.`}
        </FormatNote>
      )}

      {!formatLocked && (
      <FormatGroup>
        <FormatRow label="Font" disabled={!isStyleSupported} accessibilityHint={isStyleSupported ? undefined : 'Locked to the original font'}>
          <ChoiceSegments options={FAMILIES} value={fontFamily} onChange={setFontFamily} />
          <ToggleButton icon="bold" label="Bold" active={isBold} onToggle={() => setIsBold((b) => !b)} />
          <ToggleButton icon="italic" label="Italic" active={isItalic} onToggle={() => setIsItalic((i) => !i)} />
        </FormatRow>
        <FormatRow label="Size">
          <SizeStepper value={fontSize} onChange={setFontSize} min={MIN_SIZE} max={MAX_SIZE} presets={PRESET_SIZES} />
        </FormatRow>
        {isInsertMode && (
          <FormatRow label="Align">
            <ChoiceSegments options={ALIGNMENTS} value={alignment} onChange={setAlignment} style={styles.alignSegments} />
          </FormatRow>
        )}
        <FormatRow label="Colour">
          <ColorSwatches colors={swatches} value={color} onChange={setColor} accessibilityPrefix="Text colour" />
        </FormatRow>
      </FormatGroup>
      )}
    </EditorSheet>
  );
};

const styles = StyleSheet.create({
  textInput: {
    minHeight: 64,
    maxHeight: 150,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingTop: 10,
    paddingBottom: 10,
    ...typography.bodyLarge,
    lineHeight: undefined,
    textAlignVertical: 'top',
  },
  alignSegments: { flex: 0, width: 132 },
});
