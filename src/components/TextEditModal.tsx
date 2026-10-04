import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { TextRegion } from '../types/document';
import { colors, spacing } from '../constants/theme';

const PRESET_SIZES = [12, 14, 16, 20, 24, 32];
const COLOR_SWATCHES = [
  '#000000',
  '#007AFF',
  '#34C759',
  '#FF3B30',
  '#FF9500',
  '#8E8E93',
  '#FFFFFF',
];

export interface TextEditModalConfirmStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: 'normal' | 'italic';
  color?: string;
}

interface TextEditModalProps {
  visible: boolean;
  region?: TextRegion | null;
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
  isInsertMode = false,
  isProcessing,
  onConfirm,
  onDelete,
  onCancel,
}) => {
  const [editText, setEditText] = useState('');
  const [fontFamily, setFontFamily] = useState('sans-serif');
  const [fontSize, setFontSize] = useState(16);
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [textColor, setTextColor] = useState('#000000');
  const theme = colors.light;

  useEffect(() => {
    if (region && !isInsertMode) {
      setEditText(region.currentText || region.originalText || '');
      setFontFamily(region.style.fontFamily || 'sans-serif');
      setFontSize(Math.round(region.style.fontSize) || 16);
      setIsBold(region.style.fontWeight === 'bold' || region.style.fontWeight === '700');
      setIsItalic(region.style.fontStyle === 'italic');
      setTextColor(region.style.color || '#000000');
    } else if (isInsertMode) {
      setEditText('');
      setFontFamily('sans-serif');
      setFontSize(18);
      setIsBold(false);
      setIsItalic(false);
      setTextColor('#000000');
    }
  }, [region, isInsertMode, visible]);

  if (!visible) return null;

  const handleConfirm = () => {
    if (!editText.trim()) return;
    onConfirm(editText.trim(), {
      fontFamily,
      fontSize,
      fontWeight: isBold ? 'bold' : 'normal',
      fontStyle: isItalic ? 'italic' : 'normal',
      color: textColor,
    });
  };

  const title = isInsertMode ? 'Add Text' : 'Edit Text';
  const subtitle = isInsertMode
    ? 'Enter text to add to this image'
    : 'Edit the selected text and choose formatting';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
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
            {/* Text Input */}
            <Text style={styles.sectionLabel}>Text</Text>
            <TextInput
              value={editText}
              onChangeText={setEditText}
              style={styles.textInput}
              placeholder={isInsertMode ? 'Enter text here...' : 'Enter replacement text...'}
              placeholderTextColor={theme.textMuted}
              multiline
              autoFocus
              selectTextOnFocus={!isInsertMode}
            />

            {/* Font Family Segmented Control */}
            <Text style={styles.sectionLabel}>Font</Text>
            <View style={styles.segmentGroup}>
              <TouchableOpacity
                onPress={() => setFontFamily('sans-serif')}
                style={[styles.segmentBtn, fontFamily === 'sans-serif' && styles.segmentBtnActive]}>
                <Text style={[styles.segmentText, fontFamily === 'sans-serif' && styles.segmentTextActive]}>
                  System
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setFontFamily('serif')}
                style={[styles.segmentBtn, fontFamily === 'serif' && styles.segmentBtnActive]}>
                <Text style={[styles.segmentText, fontFamily === 'serif' && styles.segmentTextActive, { fontFamily: 'serif' }]}>
                  Serif
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
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
                <View style={styles.styleGroup}>
                  <TouchableOpacity
                    onPress={() => setIsBold(!isBold)}
                    style={[styles.styleBtn, isBold && styles.styleBtnActive]}>
                    <Text style={[styles.styleBtnText, isBold && styles.styleBtnTextActive, { fontWeight: '700' }]}>
                      B
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
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
                  onPress={() => setTextColor(hex)}
                  style={[
                    styles.swatch,
                    { backgroundColor: hex },
                    textColor === hex && styles.swatchActive,
                  ]}>
                  {textColor === hex && (
                    <Text style={[styles.swatchCheck, { color: hex === '#FFFFFF' ? '#000000' : '#FFFFFF' }]}>
                      ✓
                    </Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {/* Action Buttons */}
          <View style={styles.actionRow}>
            {!isInsertMode && onDelete && (
              <TouchableOpacity
                onPress={onDelete}
                disabled={isProcessing}
                style={styles.deleteBtn}>
                <Text style={styles.deleteBtnText}>Delete</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onCancel} style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={isProcessing || !editText.trim()}
              style={[styles.doneBtn, (isProcessing || !editText.trim()) && styles.doneBtnDisabled]}>
              {isProcessing ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.doneBtnText}>
                  {isInsertMode ? 'Add Text' : 'Done'}
                </Text>
              )}
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
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
  },
  sheetContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    maxHeight: '85%',
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: -4 },
    shadowRadius: 16,
    elevation: 10,
  },
  grabberContainer: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#D1D1D6',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  headerTitles: {
    flex: 1,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000000',
  },
  sheetSubtitle: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 2,
  },
  closeBtn: {
    padding: spacing.xs,
    marginLeft: spacing.sm,
  },
  closeBtnText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#8E8E93',
  },
  sheetBody: {
    paddingVertical: spacing.md,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3C3C43',
    marginBottom: spacing.xs,
    marginTop: spacing.xs,
  },
  textInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    color: '#000000',
    fontSize: 16,
    padding: 12,
    minHeight: 52,
    marginBottom: spacing.sm,
  },
  segmentGroup: {
    flexDirection: 'row',
    backgroundColor: '#E5E5EA',
    borderRadius: 8,
    padding: 2,
    marginBottom: spacing.sm,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 7,
    alignItems: 'center',
  },
  segmentBtnActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    elevation: 2,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#3C3C43',
  },
  segmentTextActive: {
    color: '#000000',
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xs,
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
    height: 38,
    borderRadius: 8,
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  styleBtnActive: {
    backgroundColor: '#007AFF',
  },
  styleBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#3C3C43',
  },
  styleBtnTextActive: {
    color: '#FFFFFF',
  },
  stepperContainer: {
    flexDirection: 'row',
    height: 38,
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
  },
  stepBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 1,
    elevation: 1,
  },
  stepBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
  },
  currentSizeText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
  },
  presetRow: {
    flexDirection: 'row',
    gap: 6,
    marginVertical: spacing.xs,
  },
  presetBtn: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#F2F2F7',
  },
  presetBtnActive: {
    backgroundColor: '#007AFF',
  },
  presetBtnText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#3C3C43',
  },
  presetBtnTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  swatchRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    elevation: 2,
  },
  swatchActive: {
    borderWidth: 2,
    borderColor: '#007AFF',
    transform: [{ scale: 1.15 }],
  },
  swatchCheck: {
    fontSize: 13,
    fontWeight: '900',
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.sm,
  },
  deleteBtn: {
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderRadius: 10,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
  },
  deleteBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#DC2626',
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
  },
  cancelBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#3C3C43',
  },
  doneBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#007AFF',
    alignItems: 'center',
  },
  doneBtnDisabled: {
    opacity: 0.4,
  },
  doneBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
