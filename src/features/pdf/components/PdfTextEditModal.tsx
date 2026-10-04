import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { PdfTextObject, PdfTextFormatOptions } from '../types';
import { colors, radius, spacing, typography } from '../../../constants/theme';

interface PdfTextEditModalProps {
  visible: boolean;
  targetObject: PdfTextObject | null;
  isInsertMode?: boolean;
  onApply: (text: string, format: PdfTextFormatOptions) => void;
  onCancel: () => void;
}

const PRESET_SIZES = [10, 12, 14, 16, 18, 24, 32];
const COLOR_SWATCHES = [
  '#000000',
  '#007AFF',
  '#34C759',
  '#FF3B30',
  '#FF9500',
  '#8E8E93',
];

export const PdfTextEditModal: React.FC<PdfTextEditModalProps> = ({
  visible,
  targetObject,
  isInsertMode = false,
  onApply,
  onCancel,
}) => {
  const theme = colors.light;

  const [text, setText] = useState<string>('');
  const [fontSize, setFontSize] = useState<number>(14);
  const [fontFamily, setFontFamily] = useState<'sans-serif' | 'serif' | 'monospace'>('sans-serif');
  const [isBold, setIsBold] = useState<boolean>(false);
  const [isItalic, setIsItalic] = useState<boolean>(false);
  const [color, setColor] = useState<string>('#000000');

  const isNested = Boolean(targetObject?.objectPath && targetObject.objectPath.length > 1);
  const isEmbeddedOrSubset = Boolean(
    targetObject?.fontDetails?.isSubset || targetObject?.fontDetails?.isEmbedded,
  );
  const isStyleSupported = isInsertMode || (!isNested && !isEmbeddedOrSubset);

  useEffect(() => {
    if (visible) {
      if (isInsertMode) {
        setText('');
        setFontSize(14);
        setFontFamily('sans-serif');
        setIsBold(false);
        setIsItalic(false);
        setColor('#000000');
      } else if (targetObject) {
        setText(targetObject.text);
        setFontSize(targetObject.fontSize ? Math.round(targetObject.fontSize) : 14);

        const lowerFont = (targetObject.fontName || '').toLowerCase();
        if (lowerFont.includes('times') || lowerFont.includes('serif') || lowerFont.includes('roman')) {
          setFontFamily('serif');
        } else if (lowerFont.includes('courier') || lowerFont.includes('mono')) {
          setFontFamily('monospace');
        } else {
          setFontFamily('sans-serif');
        }

        setIsBold(lowerFont.includes('bold'));
        setIsItalic(lowerFont.includes('italic') || lowerFont.includes('oblique'));
        setColor(targetObject.color || '#000000');
      }
    }
  }, [visible, targetObject, isInsertMode]);

  const handleApply = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (!isStyleSupported) {
      // Preserve original font and avoid unsupported style substitutions
      onApply(trimmed, {
        fontSize,
        color,
      });
    } else {
      onApply(trimmed, {
        fontFamily,
        fontSize,
        isBold,
        isItalic,
        color,
      });
    }
  };

  const title = isInsertMode ? 'Add Text' : 'Edit Text';
  const subtitle = isInsertMode
    ? 'Enter text to add to this page'
    : 'Edit the selected text and choose formatting';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalOverlay}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onCancel}
        />

        <View style={styles.sheetContainer}>
          {/* iOS Grabber */}
          <View style={styles.grabberContainer}>
            <View style={styles.grabber} />
          </View>

          {/* Header */}
          <View style={styles.sheetHeader}>
            <View style={styles.headerTitles}>
              <Text style={styles.sheetTitle}>{title}</Text>
              <Text style={styles.sheetSubtitle}>{subtitle}</Text>
            </View>
            <TouchableOpacity
              onPress={onCancel}
              style={styles.closeBtn}
              accessibilityLabel="Close dialog">
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.sheetBody} showsVerticalScrollIndicator={false}>
            {/* Original Font Metadata Banner for Existing Text */}
            {!isInsertMode && targetObject && (
              <View style={styles.metadataCard}>
                <View style={styles.metadataRow}>
                  <Text style={styles.metadataLabel}>Original Font:</Text>
                  <Text style={styles.metadataValue} numberOfLines={1}>
                    {targetObject.fontName || 'Standard Font'}
                  </Text>
                </View>
                {!isStyleSupported && (
                  <View style={styles.unsupportedBadgeContainer}>
                    <Text style={styles.unsupportedBadgeText}>
                      {isEmbeddedOrSubset ? 'Embedded Subset Font' : 'Form XObject'}
                    </Text>
                    <Text style={styles.unsupportedHelpText}>
                      Original font preserved. Font family and bold/italic style modification is unsupported on {isEmbeddedOrSubset ? 'subset fonts' : 'nested Form XObjects'}.
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Text Input */}
            <Text style={styles.sectionLabel}>Text</Text>
            <TextInput
              value={text}
              onChangeText={setText}
              style={styles.textInput}
              placeholder={isInsertMode ? 'Enter text here...' : 'Enter replacement text...'}
              placeholderTextColor={theme.textMuted}
              multiline
              autoFocus
              selectTextOnFocus={!isInsertMode}
            />

            {/* Font Family Segmented Control */}
            <Text style={styles.sectionLabel}>Font</Text>
            <View
              style={[
                styles.segmentGroup,
                !isStyleSupported && styles.disabledSection,
              ]}
              pointerEvents={isStyleSupported ? 'auto' : 'none'}>
              <TouchableOpacity
                disabled={!isStyleSupported}
                onPress={() => setFontFamily('sans-serif')}
                style={[styles.segmentBtn, fontFamily === 'sans-serif' && styles.segmentBtnActive]}>
                <Text style={[styles.segmentText, fontFamily === 'sans-serif' && styles.segmentTextActive]}>
                  System
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={!isStyleSupported}
                onPress={() => setFontFamily('serif')}
                style={[styles.segmentBtn, fontFamily === 'serif' && styles.segmentBtnActive]}>
                <Text style={[styles.segmentText, fontFamily === 'serif' && styles.segmentTextActive, { fontFamily: 'serif' }]}>
                  Serif
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={!isStyleSupported}
                onPress={() => setFontFamily('monospace')}
                style={[styles.segmentBtn, fontFamily === 'monospace' && styles.segmentBtnActive]}>
                <Text style={[styles.segmentText, fontFamily === 'monospace' && styles.segmentTextActive, { fontFamily: 'monospace' }]}>
                  Mono
                </Text>
              </TouchableOpacity>
            </View>

            {/* Style & Size Row */}
            <View style={styles.row}>
              {/* Style Buttons */}
              <View style={styles.flexHalf}>
                <Text style={styles.sectionLabel}>Style</Text>
                <View
                  style={[
                    styles.styleGroup,
                    !isStyleSupported && styles.disabledSection,
                  ]}
                  pointerEvents={isStyleSupported ? 'auto' : 'none'}>
                  <TouchableOpacity
                    disabled={!isStyleSupported}
                    onPress={() => setIsBold(!isBold)}
                    style={[styles.styleBtn, isBold && styles.styleBtnActive]}>
                    <Text style={[styles.styleBtnText, isBold && styles.styleBtnTextActive, { fontWeight: '700' }]}>
                      B
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={!isStyleSupported}
                    onPress={() => setIsItalic(!isItalic)}
                    style={[styles.styleBtn, isItalic && styles.styleBtnActive]}>
                    <Text style={[styles.styleBtnText, isItalic && styles.styleBtnTextActive, { fontStyle: 'italic' }]}>
                      I
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Font Size Stepper */}
              <View style={styles.flexHalf}>
                <Text style={styles.sectionLabel}>Size ({fontSize} pt)</Text>
                <View style={styles.stepperContainer}>
                  <TouchableOpacity
                    onPress={() => setFontSize(Math.max(8, fontSize - 2))}
                    style={styles.stepBtn}>
                    <Text style={styles.stepBtnText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.currentSizeText}>{fontSize}</Text>
                  <TouchableOpacity
                    onPress={() => setFontSize(Math.min(72, fontSize + 2))}
                    style={styles.stepBtn}>
                    <Text style={styles.stepBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* Size Presets */}
            <View style={styles.presetRow}>
              {PRESET_SIZES.map((sz) => (
                <TouchableOpacity
                  key={sz}
                  onPress={() => setFontSize(sz)}
                  style={[styles.presetBtn, fontSize === sz && styles.presetBtnActive]}>
                  <Text style={[styles.presetBtnText, fontSize === sz && styles.presetBtnTextActive]}>
                    {sz}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Color Swatches */}
            <Text style={styles.sectionLabel}>Color</Text>
            <View style={styles.swatchRow}>
              {COLOR_SWATCHES.map((hex) => (
                <TouchableOpacity
                  key={hex}
                  onPress={() => setColor(hex)}
                  style={[
                    styles.swatch,
                    { backgroundColor: hex },
                    color === hex && styles.swatchActive,
                  ]}>
                  {color === hex && (
                    <Text style={[styles.swatchCheck, { color: hex === '#000000' ? '#FFFFFF' : '#FFFFFF' }]}>
                      ✓
                    </Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {/* Action Buttons */}
          <View style={styles.sheetFooter}>
            <TouchableOpacity
              onPress={onCancel}
              style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleApply}
              disabled={text.trim().length === 0}
              style={[
                styles.applyBtn,
                text.trim().length === 0 && styles.applyBtnDisabled,
              ]}>
              <Text style={styles.applyBtnText}>
                {isInsertMode ? 'Insert Text' : 'Apply Changes'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  sheetContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.xs,
    paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.md,
    maxHeight: '85%',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 16,
  },
  grabberContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D1D1D6',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  headerTitles: {
    flex: 1,
  },
  sheetTitle: {
    ...typography.titleMedium,
    color: '#000000',
    fontWeight: '700',
  },
  sheetSubtitle: {
    ...typography.caption,
    color: '#8E8E93',
    marginTop: 2,
  },
  closeBtn: {
    padding: spacing.xs,
    marginLeft: spacing.sm,
  },
  closeBtnText: {
    fontSize: 16,
    color: '#8E8E93',
    fontWeight: '600',
  },
  sheetBody: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  metadataCard: {
    backgroundColor: '#F2F2F7',
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  metadataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metadataLabel: {
    ...typography.caption,
    color: '#8E8E93',
    fontWeight: '600',
  },
  metadataValue: {
    ...typography.caption,
    color: '#1C1C1E',
    fontWeight: '700',
    flex: 1,
    textAlign: 'right',
    marginLeft: spacing.xs,
  },
  unsupportedBadgeContainer: {
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
  },
  unsupportedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FF9500',
    marginBottom: 2,
  },
  unsupportedHelpText: {
    fontSize: 11,
    color: '#8E8E93',
    lineHeight: 14,
  },
  disabledSection: {
    opacity: 0.45,
  },
  sectionLabel: {
    ...typography.bodyMedium,
    fontWeight: '600',
    color: '#1C1C1E',
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#E5E5EA',
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: 16,
    color: '#000000',
    minHeight: 70,
    backgroundColor: '#FAFAFA',
    textAlignVertical: 'top',
  },
  segmentGroup: {
    flexDirection: 'row',
    backgroundColor: '#F2F2F7',
    borderRadius: radius.sm,
    padding: 2,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    borderRadius: radius.sm - 2,
  },
  segmentBtnActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 2,
  },
  segmentText: {
    ...typography.bodyMedium,
    color: '#8E8E93',
    fontWeight: '500',
  },
  segmentTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  flexHalf: {
    flex: 1,
  },
  styleGroup: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  styleBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    backgroundColor: '#FAFAFA',
  },
  styleBtnActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  styleBtnText: {
    ...typography.bodyMedium,
    color: '#1C1C1E',
  },
  styleBtnTextActive: {
    color: '#FFFFFF',
  },
  stepperContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#E5E5EA',
    borderRadius: radius.sm,
    backgroundColor: '#FAFAFA',
    overflow: 'hidden',
  },
  stepBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#007AFF',
  },
  currentSizeText: {
    ...typography.bodyMedium,
    fontWeight: '700',
    color: '#1C1C1E',
    minWidth: 28,
    textAlign: 'center',
  },
  presetRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
    gap: 4,
  },
  presetBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    borderRadius: radius.sm,
    paddingVertical: 4,
    alignItems: 'center',
    backgroundColor: '#FAFAFA',
  },
  presetBtnActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  presetBtnText: {
    fontSize: 12,
    color: '#8E8E93',
    fontWeight: '500',
  },
  presetBtnTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  swatchRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchActive: {
    borderColor: '#007AFF',
    transform: [{ scale: 1.15 }],
  },
  swatchCheck: {
    fontSize: 14,
    fontWeight: '700',
  },
  sheetFooter: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
  },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    ...typography.titleSmall,
    color: '#8E8E93',
    fontWeight: '600',
  },
  applyBtn: {
    flex: 2,
    backgroundColor: '#007AFF',
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyBtnDisabled: {
    backgroundColor: '#B0B0B5',
  },
  applyBtnText: {
    ...typography.titleSmall,
    color: '#FFFFFF',
    fontWeight: '700',
  },
});
