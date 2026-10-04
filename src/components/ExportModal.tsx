import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { ExportFormat } from '../features/export/types';
import { colors, radius, spacing, typography } from '../constants/theme';

interface ExportModalProps {
  visible: boolean;
  documentWidth: number;
  documentHeight: number;
  isExporting: boolean;
  onExport: (format: ExportFormat, quality: number) => void;
  onCancel: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  visible,
  documentWidth,
  documentHeight,
  isExporting,
  onExport,
  onCancel,
}) => {
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('png');
  const [quality, setQuality] = useState<number>(95);
  const theme = colors.light;

  const handleConfirm = () => {
    onExport(selectedFormat, quality);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={[styles.modalCard, { backgroundColor: theme.surface }]}>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={[styles.title, { color: theme.textPrimary }]}>
                Export Image
              </Text>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                Save or share your edited image
              </Text>
            </View>
            <TouchableOpacity
              onPress={onCancel}
              disabled={isExporting}
              style={styles.closeButton}>
              <Text style={[styles.closeIcon, { color: theme.textSecondary }]}>
                ✕
              </Text>
            </TouchableOpacity>
          </View>

          {/* Body */}
          <View style={styles.body}>
            {/* Dimensions Badge */}
            <View style={[styles.resolutionCard, { backgroundColor: theme.background }]}>
              <Text style={[styles.label, { color: theme.textSecondary }]}>
                IMAGE RESOLUTION
              </Text>
              <Text style={[styles.resolutionValue, { color: theme.textPrimary }]}>
                {documentWidth} × {documentHeight} px
              </Text>
              <Text style={[styles.resolutionSub, { color: theme.textSecondary }]}>
                Full original quality
              </Text>
            </View>

            {/* Format Selection */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: theme.textSecondary }]}>
                EXPORT FORMAT
              </Text>
              <View style={styles.formatRow}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => setSelectedFormat('png')}
                  style={[
                    styles.formatCard,
                    { borderColor: theme.border },
                    selectedFormat === 'png' && {
                      borderColor: theme.primary,
                      backgroundColor: theme.primarySubtle,
                    },
                  ]}>
                  <Text
                    style={[
                      styles.formatTitle,
                      {
                        color:
                          selectedFormat === 'png'
                            ? theme.primary
                            : theme.textPrimary,
                      },
                    ]}>
                    PNG
                  </Text>
                  <Text style={[styles.formatDesc, { color: theme.textSecondary }]}>
                    Lossless quality • Recommended for crisp text
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => setSelectedFormat('jpeg')}
                  style={[
                    styles.formatCard,
                    { borderColor: theme.border },
                    selectedFormat === 'jpeg' && {
                      borderColor: theme.primary,
                      backgroundColor: theme.primarySubtle,
                    },
                  ]}>
                  <Text
                    style={[
                      styles.formatTitle,
                      {
                        color:
                          selectedFormat === 'jpeg'
                            ? theme.primary
                            : theme.textPrimary,
                      },
                    ]}>
                    JPEG
                  </Text>
                  <Text style={[styles.formatDesc, { color: theme.textSecondary }]}>
                    High quality • Compact file size
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Quality Preset for JPEG */}
            {selectedFormat === 'jpeg' && (
              <View style={styles.section}>
                <Text style={[styles.label, { color: theme.textSecondary }]}>
                  JPEG QUALITY PRESET
                </Text>
                <View style={styles.presetRow}>
                  {[85, 92, 98].map(q => (
                    <TouchableOpacity
                      key={q}
                      activeOpacity={0.8}
                      onPress={() => setQuality(q)}
                      style={[
                        styles.presetBtn,
                        { borderColor: theme.border },
                        quality === q && {
                          borderColor: theme.primary,
                          backgroundColor: theme.primarySubtle,
                        },
                      ]}>
                      <Text
                        style={[
                          styles.presetText,
                          {
                            color:
                              quality === q
                                ? theme.primary
                                : theme.textPrimary,
                          },
                        ]}>
                        {q === 98 ? 'Max (98%)' : q === 92 ? 'High (92%)' : 'Good (85%)'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </View>

          {/* Footer */}
          <View style={[styles.footer, { borderTopColor: theme.border }]}>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={onCancel}
              disabled={isExporting}
              style={[styles.cancelBtn, { borderColor: theme.border }]}>
              <Text style={[styles.cancelBtnText, { color: theme.textSecondary }]}>
                Cancel
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.8}
              onPress={handleConfirm}
              disabled={isExporting}
              style={[
                styles.confirmBtn,
                { backgroundColor: theme.primary },
                isExporting && styles.btnDisabled,
              ]}>
              {isExporting ? (
                <View style={styles.exportingRow}>
                  <ActivityIndicator size="small" color="#FFFFFF" />
                  <Text style={styles.confirmBtnText}>Compositing...</Text>
                </View>
              ) : (
                <Text style={styles.confirmBtnText}>Export & Share</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: {
    ...typography.titleMedium,
    fontWeight: '700',
  },
  subtitle: {
    ...typography.caption,
    marginTop: 2,
  },
  closeButton: {
    padding: spacing.xs,
  },
  closeIcon: {
    fontSize: 18,
    fontWeight: '600',
  },
  body: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  resolutionCard: {
    padding: spacing.md,
    borderRadius: radius.md,
    gap: 2,
  },
  label: {
    ...typography.caption,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  resolutionValue: {
    ...typography.titleMedium,
    fontWeight: '700',
    marginVertical: 2,
  },
  resolutionSub: {
    ...typography.caption,
  },
  section: {
    gap: spacing.xs,
  },
  formatRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  formatCard: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  formatTitle: {
    ...typography.bodyMedium,
    fontWeight: '700',
  },
  formatDesc: {
    ...typography.caption,
    fontSize: 11,
  },
  presetRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  presetBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetText: {
    ...typography.caption,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    marginTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cancelBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 4,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    ...typography.bodyMedium,
    fontWeight: '600',
  },
  confirmBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 4,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 150,
  },
  confirmBtnText: {
    ...typography.bodyMedium,
    color: '#FFFFFF',
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  exportingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
