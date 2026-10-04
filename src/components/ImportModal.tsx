import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
} from 'react-native';
import { colors, radius, spacing, typography } from '../constants/theme';

export interface ImportModalProps {
  visible: boolean;
  kind: 'pdf' | 'image';
  onSelectOption: (source: 'files' | 'photos') => void;
  onCancel: () => void;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  visible,
  kind,
  onSelectOption,
  onCancel,
}) => {
  const theme = colors.light;

  const isPdf = kind === 'pdf';
  const title = isPdf ? 'Import PDF' : 'Import Image';
  const subtitle = isPdf
    ? 'Choose a PDF document from your device storage or files'
    : 'Choose where to import your image from';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}>
      <TouchableWithoutFeedback onPress={onCancel}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.sheetContainer, { backgroundColor: theme.surface }]}>
              {/* iOS Grabber Pill */}
              <View style={styles.grabberContainer}>
                <View style={styles.grabber} />
              </View>

              {/* Sheet Header */}
              <View style={styles.header}>
                <Text style={[styles.title, { color: theme.textPrimary }]}>{title}</Text>
                <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                  {subtitle}
                </Text>
              </View>

              {/* Options */}
              <View style={styles.optionsContainer}>
                {!isPdf && (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[styles.optionCard, { borderColor: theme.border }]}
                    onPress={() => onSelectOption('photos')}>
                    <View style={[styles.iconBox, { backgroundColor: '#F0FDF4' }]}>
                      <Text style={[styles.iconText, { color: theme.success }]}>IMG</Text>
                    </View>
                    <View style={styles.optionInfo}>
                      <Text style={[styles.optionTitle, { color: theme.textPrimary }]}>
                        Photo Library
                      </Text>
                      <Text style={[styles.optionDesc, { color: theme.textSecondary }]}>
                        Select from Photos, Screenshots, or Camera Roll
                      </Text>
                    </View>
                    <Text style={[styles.chevron, { color: theme.textMuted }]}>›</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.optionCard, { borderColor: theme.border }]}
                  onPress={() => onSelectOption('files')}>
                  <View style={[styles.iconBox, { backgroundColor: isPdf ? '#EBF5FF' : '#F3F4F6' }]}>
                    <Text style={[styles.iconText, { color: isPdf ? theme.primary : '#4B5563' }]}>
                      {isPdf ? 'PDF' : 'DOC'}
                    </Text>
                  </View>
                  <View style={styles.optionInfo}>
                    <Text style={[styles.optionTitle, { color: theme.textPrimary }]}>
                      Browse Files
                    </Text>
                    <Text style={[styles.optionDesc, { color: theme.textSecondary }]}>
                      {isPdf
                        ? 'Select from Downloads, Drive, or Device Storage'
                        : 'Select image file from Downloads, Drive, or Storage'}
                    </Text>
                  </View>
                  <Text style={[styles.chevron, { color: theme.textMuted }]}>›</Text>
                </TouchableOpacity>
              </View>

              {/* Cancel Button */}
              <TouchableOpacity
                activeOpacity={0.7}
                style={[styles.cancelBtn, { backgroundColor: '#F2F2F7' }]}
                onPress={onCancel}>
                <Text style={[styles.cancelBtnText, { color: theme.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
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
  header: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    marginBottom: spacing.md,
  },
  title: {
    ...typography.titleMedium,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    ...typography.caption,
    textAlign: 'center',
    maxWidth: 280,
  },
  optionsContainer: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#FAFAFA',
  },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  iconText: {
    fontSize: 12,
    fontWeight: '700',
  },
  optionInfo: {
    flex: 1,
  },
  optionTitle: {
    ...typography.bodyMedium,
    fontWeight: '600',
    marginBottom: 2,
  },
  optionDesc: {
    fontSize: 12,
    color: '#8E8E93',
  },
  chevron: {
    fontSize: 20,
    fontWeight: '300',
    marginLeft: spacing.sm,
  },
  cancelBtn: {
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  cancelBtnText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
