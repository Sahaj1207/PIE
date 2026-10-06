import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ExportFormat } from '../features/export/types';
import { spacing, typography } from '../constants/theme';
import { useTheme } from '../ui/ThemeProvider';
import { BarButton, BottomSheet, ListRow, ListSection, PillButton, SegmentedControl } from '../ui/controls';
import { useAppSettings } from '../settings/appSettings';

/** User-chosen export action. */
export type ExportAction = 'gallery' | 'share';

interface ExportModalProps {
  visible: boolean;
  documentWidth: number;
  documentHeight: number;
  isExporting: boolean;
  /** True when the platform can publish exports to the photo library (Android 10+). */
  galleryAvailable?: boolean;
  onExport: (format: ExportFormat, quality: number, action: ExportAction) => void;
  onCancel: () => void;
}

const QUALITY_PRESETS: readonly { value: '85' | '92' | '98'; label: string }[] = [
  { value: '85', label: 'Good' },
  { value: '92', label: 'High' },
  { value: '98', label: 'Maximum' },
];

/** Nearest JPEG preset for a 0.5–1.0 settings quality. */
function presetFor(quality: number): '85' | '92' | '98' {
  const pct = quality * 100;
  if (pct >= 95) return '98';
  if (pct >= 88) return '92';
  return '85';
}

export const ExportModal: React.FC<ExportModalProps> = ({
  visible,
  documentWidth,
  documentHeight,
  isExporting,
  galleryAvailable = false,
  onExport,
  onCancel,
}) => {
  const { colors } = useTheme();
  const settings = useAppSettings();
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>(settings.defaultImageExportFormat);
  const [quality, setQuality] = useState<'85' | '92' | '98'>(presetFor(settings.defaultImageExportQuality));

  // Every export starts from the defaults chosen in Settings
  useEffect(() => {
    if (visible) {
      setSelectedFormat(settings.defaultImageExportFormat);
      setQuality(presetFor(settings.defaultImageExportQuality));
    }
  }, [visible, settings.defaultImageExportFormat, settings.defaultImageExportQuality]);

  const handleConfirm = (action: ExportAction) => {
    onExport(selectedFormat, selectedFormat === 'png' ? 100 : Number(quality), action);
  };

  const megapixels = (documentWidth * documentHeight) / 1_000_000;

  return (
    <BottomSheet
      visible={visible}
      onClose={() => {
        if (!isExporting) onCancel();
      }}
      title="Export Image"
      left={<BarButton label="Cancel" onPress={onCancel} disabled={isExporting} />}>
      <View style={styles.body}>
        <ListSection footer="Exports keep the original resolution. Your edits are composited on this device.">
          <ListRow title="Size" value={`${documentWidth} × ${documentHeight}`} />
          <ListRow title="Resolution" value={`${megapixels >= 10 ? megapixels.toFixed(0) : megapixels.toFixed(1)} MP`} />
        </ListSection>

        <View style={styles.group}>
          <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>FORMAT</Text>
          <SegmentedControl
            segments={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPEG' },
            ]}
            value={selectedFormat}
            onChange={setSelectedFormat}
          />
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            {selectedFormat === 'png' ? 'Lossless — best for crisp text.' : 'Smaller files — best for photos.'}
          </Text>
        </View>

        {selectedFormat === 'jpeg' && (
          <View style={styles.group}>
            <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>QUALITY</Text>
            <SegmentedControl segments={QUALITY_PRESETS} value={quality} onChange={setQuality} />
          </View>
        )}

        <View style={styles.actions}>
          {galleryAvailable && (
            <PillButton
              label={isExporting ? 'Exporting…' : 'Save to Photos'}
              icon="download"
              onPress={() => handleConfirm('gallery')}
              loading={isExporting}
              large
              accessibilityLabel="Save exported image to Photos"
            />
          )}
          <PillButton
            label="Share…"
            icon="share"
            tone={galleryAvailable ? 'secondary' : 'primary'}
            onPress={() => handleConfirm('share')}
            disabled={isExporting}
            loading={!galleryAvailable && isExporting}
            large
            accessibilityLabel="Share exported image"
          />
        </View>
      </View>
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: spacing.sm },
  group: { paddingHorizontal: spacing.lg, marginBottom: spacing.lg, gap: 6 },
  groupLabel: { ...typography.sectionHeader, marginLeft: spacing.lg },
  hint: { ...typography.caption, marginLeft: spacing.lg },
  actions: { paddingHorizontal: spacing.lg, gap: spacing.sm, marginTop: spacing.xs },
});
