import React, { useState, useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { AddedTextElement, TextRegion } from '../types/document';
import { platformFontFamily, resolveRenderableFontFamily } from '../features/text/textLayout';
import { fontWeights, radius, spacing, typography } from '../constants/theme';
import { useTheme } from '../ui/ThemeProvider';
import {
  ChoiceSegments,
  ColorSwatches,
  EditorSheet,
  FormatGroup,
  FormatNote,
  FormatRow,
  SizeStepper,
  ToggleButton,
} from '../ui/formatControls';

const PRESET_SIZES = [10, 12, 14, 16, 20, 24, 32, 48];
/** On-screen size (points) of newly added text. */
const DEFAULT_INSERT_SIZE_PT = 18;
const MIN_SIZE_PT = 4;
const MAX_SIZE_PT = 400;

/**
 * Document pixels per on-screen point at the image's fit zoom. Font sizes are stored in
 * DOCUMENT pixels; showing and stepping them in on-screen points keeps sizes meaningful for
 * every image resolution (an 18 px font is ~2 pt on screen for a 12 MP photo at fit).
 */
export function documentPixelsPerPoint(fitScale: number | null | undefined): number {
  if (!fitScale || !Number.isFinite(fitScale) || fitScale <= 0) return 1;
  return Math.min(64, Math.max(0.25, 1 / fitScale));
}

export const IMAGE_TEXT_COLORS = ['#000000', '#3A3A3C', '#8E8E93', '#FFFFFF', '#007AFF', '#34C759', '#FF3B30', '#FF9500', '#AF52DE'];

export interface TextEditModalConfirmStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: 'normal' | 'italic';
  color?: string;
  /** Only offered for added text (OCR replacements keep their fitted single line). */
  alignment?: 'left' | 'center' | 'right';
}

type Family = 'sans-serif' | 'serif' | 'monospace';
type Alignment = 'left' | 'center' | 'right';

const FAMILIES: readonly { value: Family; label: string; fontFamily: string }[] = [
  { value: 'sans-serif', label: 'Sans', fontFamily: platformFontFamily('sans-serif', Platform.OS) },
  { value: 'serif', label: 'Serif', fontFamily: platformFontFamily('serif', Platform.OS) },
  { value: 'monospace', label: 'Mono', fontFamily: platformFontFamily('monospace', Platform.OS) },
];

const ALIGNMENTS: readonly { value: Alignment; icon: 'alignLeft' | 'alignCenter' | 'alignRight'; accessibilityLabel: string }[] = [
  { value: 'left', icon: 'alignLeft', accessibilityLabel: 'Align Left' },
  { value: 'center', icon: 'alignCenter', accessibilityLabel: 'Align Center' },
  { value: 'right', icon: 'alignRight', accessibilityLabel: 'Align Right' },
];

function toFamily(value: string | undefined): Family {
  const resolved = resolveRenderableFontFamily(value);
  return resolved === 'serif' || resolved === 'monospace' ? resolved : 'sans-serif';
}

interface TextEditModalProps {
  /**
   * Document pixels per displayed point (see documentPixelsPerPoint). Sizes are shown and
   * stepped in points; the confirmed fontSize is in document pixels. Default 1.
   */
  fontScale?: number;
  visible: boolean;
  region?: TextRegion | null;
  /** Added-text layer being edited (prefills text and formatting). */
  addedText?: AddedTextElement | null;
  initialText?: string;
  initialStyle?: any;
  isInsertMode?: boolean;
  isProcessing: boolean;
  onConfirm: (newText: string, style: TextEditModalConfirmStyle) => void;
  onDelete?: () => void;
  onCancel: () => void;
}

export const TextEditModal: React.FC<TextEditModalProps> = ({
  visible,
  region,
  addedText = null,
  fontScale = 1,
  isInsertMode = false,
  isProcessing,
  onConfirm,
  onDelete,
  onCancel,
}) => {
  const [editText, setEditText] = useState('');
  const [fontFamily, setFontFamily] = useState<Family>('sans-serif');
  const [fontSize, setFontSize] = useState(16);
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [textColor, setTextColor] = useState('#000000');
  const [alignment, setAlignment] = useState<Alignment>('left');
  const { colors } = useTheme();
  const isAddedTextMode = isInsertMode || !!addedText;
  const isRegionMode = !isAddedTextMode && !!region;

  useEffect(() => {
    if (addedText && !isInsertMode) {
      setEditText(addedText.text);
      setFontFamily(toFamily(addedText.style.fontFamily));
      setFontSize(addedText.style.fontSize || DEFAULT_INSERT_SIZE_PT * fontScale);
      setIsBold(addedText.style.fontWeight === 'bold' || addedText.style.fontWeight === '700');
      setIsItalic(addedText.style.fontStyle === 'italic');
      setTextColor(addedText.style.color || '#000000');
      const a = addedText.style.alignment;
      setAlignment(a === 'center' || a === 'right' ? a : 'left');
    } else if (region && !isInsertMode) {
      setEditText(region.currentText || region.originalText || '');
      setFontFamily(toFamily(region.style.fontFamily));
      setFontSize(region.style.fontSize || 16 * fontScale);
      setIsBold(region.style.fontWeight === 'bold' || region.style.fontWeight === '700');
      setIsItalic(region.style.fontStyle === 'italic');
      setTextColor(region.style.color || '#000000');
    } else if (isInsertMode) {
      setEditText('');
      setFontFamily('sans-serif');
      setFontSize(DEFAULT_INSERT_SIZE_PT * fontScale);
      setIsBold(false);
      setIsItalic(false);
      setTextColor('#000000');
      setAlignment('left');
    }
  }, [region, addedText, isInsertMode, visible, fontScale]);

  // fontSize is kept in DOCUMENT pixels (exact when untouched); shown / stepped in points
  const sizePt = Math.round(fontSize / fontScale);
  const setSizePt = (pt: number) => setFontSize(Math.min(MAX_SIZE_PT, Math.max(MIN_SIZE_PT, pt)) * fontScale);

  const handleConfirm = () => {
    if (!editText.trim()) return;
    // Only leading/trailing blank space is removed; inner newlines are kept as lines.
    onConfirm(editText.trim(), {
      fontFamily,
      fontSize,
      fontWeight: isBold ? 'bold' : 'normal',
      fontStyle: isItalic ? 'italic' : 'normal',
      color: textColor,
      ...(isAddedTextMode ? { alignment } : {}),
    });
  };

  const swatches = IMAGE_TEXT_COLORS.some((c) => c.toUpperCase() === textColor.toUpperCase())
    ? IMAGE_TEXT_COLORS
    : [textColor.toUpperCase(), ...IMAGE_TEXT_COLORS];

  return (
    <EditorSheet
      visible={visible}
      title={isInsertMode ? 'Add Text' : 'Edit Text'}
      confirmLabel={isInsertMode ? 'Add' : 'Done'}
      confirmDisabled={!editText.trim()}
      confirmLoading={isProcessing}
      onConfirm={handleConfirm}
      onCancel={onCancel}>
      <TextInput
        value={editText}
        onChangeText={setEditText}
        style={[
          styles.textInput,
          {
            backgroundColor: colors.cell,
            color: colors.textPrimary,
            fontFamily: platformFontFamily(fontFamily, Platform.OS),
            fontWeight: isBold ? '700' : '400',
            fontStyle: isItalic ? 'italic' : 'normal',
            textAlign: isAddedTextMode ? alignment : 'left',
          },
        ]}
        placeholder={isInsertMode ? 'Type your text' : 'Replacement text'}
        placeholderTextColor={colors.textMuted}
        multiline
        autoFocus
        selectTextOnFocus={!isInsertMode}
        accessibilityLabel="Text"
      />

      {isRegionMode && (
        <FormatNote icon="scanText">
          The original text is removed and the background behind it is rebuilt on this device.
        </FormatNote>
      )}

      <FormatGroup>
        <FormatRow label="Font">
          <ChoiceSegments options={FAMILIES} value={fontFamily} onChange={setFontFamily} />
          <ToggleButton icon="bold" label="Bold" active={isBold} onToggle={() => setIsBold((b) => !b)} />
          <ToggleButton icon="italic" label="Italic" active={isItalic} onToggle={() => setIsItalic((i) => !i)} />
        </FormatRow>
        <FormatRow label="Size">
          <SizeStepper value={sizePt} onChange={setSizePt} min={MIN_SIZE_PT} max={MAX_SIZE_PT} presets={PRESET_SIZES} />
        </FormatRow>
        {isAddedTextMode && (
          <FormatRow label="Align">
            <ChoiceSegments options={ALIGNMENTS} value={alignment} onChange={setAlignment} style={styles.alignSegments} />
          </FormatRow>
        )}
        <FormatRow label="Colour">
          <ColorSwatches colors={swatches} value={textColor} onChange={setTextColor} accessibilityPrefix="Text colour" />
        </FormatRow>
      </FormatGroup>

      {!isInsertMode && onDelete && (
        <Pressable
          onPress={onDelete}
          disabled={isProcessing}
          accessibilityRole="button"
          accessibilityLabel="Delete text"
          style={({ pressed }) => [styles.deleteRow, { backgroundColor: pressed ? colors.cellPressed : colors.cell }, isProcessing && styles.dim]}>
          <Text style={[styles.deleteText, { color: colors.danger }]}>Delete Text</Text>
        </Pressable>
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
  deleteRow: { minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  deleteText: { ...typography.bodyLarge, fontWeight: fontWeights.regular },
  dim: { opacity: 0.4 },
});
