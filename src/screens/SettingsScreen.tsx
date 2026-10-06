import React, { useCallback, useEffect, useState } from 'react';
import { Modal, NativeModules, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SettingsScreenNavigationProp } from '../navigation/types';
import { appSettings, useAppSettings } from '../settings/appSettings';
import { useTheme } from '../ui/ThemeProvider';
import { BackButton, BarButton, BottomSheet, ListRow, ListSection, NavBar, SegmentedControl } from '../ui/controls';
import { showAlert, showToast } from '../ui/overlays';
import { documentActivity } from '../features/documents/documentActivity';
import { formatBytes } from '../features/library/libraryService';
import { clearThumbnailCache } from '../features/library/libraryService';
import { OnboardingView } from './OnboardingScreen';
import { spacing, typography } from '../constants/theme';

interface AppInfo {
  version: string;
  build: string;
}

const NOTICES: readonly { name: string; license: string; note: string }[] = [
  { name: 'PDFium', license: 'BSD 3-Clause / Apache 2.0', note: 'PDF rendering and editing engine (Google / Foxit).' },
  { name: 'Google ML Kit Text Recognition', license: 'ML Kit Terms of Service', note: 'On-device text recognition on Android. Runs offline.' },
  { name: 'Apple Vision', license: 'Apple SDK', note: 'On-device text recognition on iOS.' },
  { name: 'React Native', license: 'MIT', note: 'Application framework (Meta Platforms, Inc.).' },
  { name: 'React Navigation', license: 'MIT', note: 'Screen navigation.' },
  { name: 'React Native Skia', license: 'MIT', note: 'Canvas drawing (Shopify). Skia is BSD 3-Clause (Google).' },
  { name: 'React Native Reanimated / Gesture Handler / Worklets', license: 'MIT', note: 'Animations and gestures (Software Mansion).' },
  { name: 'React Native Image Picker', license: 'MIT', note: 'Photo library and camera access.' },
  { name: 'React Native Safe Area Context / Screens', license: 'MIT', note: 'Layout and native screens.' },
];

export const SettingsScreen: React.FC = () => {
  const navigation = useNavigation<SettingsScreenNavigationProp>();
  const settings = useAppSettings();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [usage, setUsage] = useState<{ documentsBytes: number; cacheBytes: number } | null>(null);
  const [noticesVisible, setNoticesVisible] = useState(false);
  const [tourVisible, setTourVisible] = useState(false);

  const refreshUsage = useCallback(() => {
    const mod = NativeModules.PieAppModule;
    if (mod?.getStorageUsage) {
      mod.getStorageUsage().then(setUsage).catch(() => setUsage(null));
    }
  }, []);

  useEffect(() => {
    const mod = NativeModules.PieAppModule;
    if (mod?.getAppInfo) mod.getAppInfo().then(setInfo).catch(() => {});
    refreshUsage();
  }, [refreshUsage]);

  const clearCache = () => {
    if (documentActivity.hasAnyActive()) {
      showAlert('Close Open Documents', 'Temporary files can be cleared once no document is open, saving or exporting.');
      return;
    }
    const mod = NativeModules.PieAppModule;
    if (!mod?.clearCaches) return;
    mod
      .clearCaches()
      .then((freed: number) => {
        clearThumbnailCache();
        showToast(`Cleared ${formatBytes(freed)}`, { tone: 'success' });
        refreshUsage();
      })
      .catch(() => showAlert('Unable to Clear', 'Temporary files could not be removed.'));
  };

  const appearanceRow = (value: 'system' | 'light' | 'dark', title: string) => (
    <ListRow title={title} checked={settings.appearance === value} onPress={() => appSettings.update({ appearance: value })} />
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.groupedBackground }]}>
      <NavBar title="Settings" left={<BackButton label="Library" onPress={() => navigation.goBack()} />} />
      <ScrollView contentContainerStyle={{ paddingTop: spacing.xl, paddingBottom: insets.bottom + spacing.xxxl }}>
        <ListSection header="Appearance">
          {appearanceRow('system', 'Automatic')}
          {appearanceRow('light', 'Light')}
          {appearanceRow('dark', 'Dark')}
        </ListSection>

        <ListSection header="Image Export" footer="Used when sharing images from the Library. You can choose differently each time you export from the editor.">
          <View style={styles.inlineControl}>
            <Text style={[styles.inlineLabel, { color: colors.textPrimary }]}>Format</Text>
            <SegmentedControl
              segments={[
                { value: 'png', label: 'PNG' },
                { value: 'jpeg', label: 'JPEG' },
              ]}
              value={settings.defaultImageExportFormat}
              onChange={(v) => appSettings.update({ defaultImageExportFormat: v })}
              style={styles.inlineSegments}
            />
          </View>
          {settings.defaultImageExportFormat === 'jpeg' && (
            <View style={styles.inlineControl}>
              <Text style={[styles.inlineLabel, { color: colors.textPrimary }]}>Quality</Text>
              <SegmentedControl
                segments={[
                  { value: '0.75', label: 'Medium' },
                  { value: '0.92', label: 'High' },
                  { value: '1', label: 'Maximum' },
                ]}
                value={String(settings.defaultImageExportQuality) as '0.75' | '0.92' | '1'}
                onChange={(v) => appSettings.update({ defaultImageExportQuality: Number(v) })}
                style={styles.inlineSegments}
              />
            </View>
          )}
        </ListSection>

        <ListSection header="Editing">
          <ListRow
            title="Haptic Feedback"
            icon="hand"
            iconColor={colors.primary}
            switchValue={settings.haptics}
            onSwitchChange={(v) => appSettings.update({ haptics: v })}
          />
          <ListRow
            title="Confirm Before Deleting"
            icon="trash"
            iconColor={colors.danger}
            switchValue={settings.confirmDestructive}
            onSwitchChange={(v) => appSettings.update({ confirmDestructive: v })}
          />
        </ListSection>

        <ListSection header="Storage" footer="Temporary files are page renders, thumbnails and copies prepared for sharing. Your documents are not affected.">
          <ListRow title="Documents" icon="folder" iconColor={colors.warning} value={usage ? formatBytes(usage.documentsBytes) : '—'} />
          <ListRow title="Temporary Files" icon="storage" iconColor="#8E8E93" value={usage ? formatBytes(usage.cacheBytes) : '—'} />
          <ListRow title="Clear Temporary Files" onPress={clearCache} accessibilityLabel="Clear temporary files" />
        </ListSection>

        <ListSection
          header="Privacy"
          footer="PIE works entirely offline. Documents, text recognition and image editing are processed on this device. There is no account, no analytics and nothing is uploaded.">
          <ListRow title="On-Device Processing" icon="shield" iconColor={colors.success} value="Always" />
        </ListSection>

        <ListSection header="About">
          <ListRow title="Version" value={info ? `${info.version} (${info.build})` : '1.0'} />
          <ListRow title="Welcome Tour" chevron onPress={() => setTourVisible(true)} />
          <ListRow title="Acknowledgements" chevron onPress={() => setNoticesVisible(true)} />
        </ListSection>

        <Text style={[styles.footer, { color: colors.textMuted }]}>
          PIE — PDF & Image Editor{'\n'}Made for {Platform.OS === 'ios' ? 'iPhone and iPad' : 'Android'}
        </Text>
      </ScrollView>

      <BottomSheet
        visible={noticesVisible}
        onClose={() => setNoticesVisible(false)}
        title="Acknowledgements"
        heightFraction={0.8}
        right={<BarButton label="Done" prominent onPress={() => setNoticesVisible(false)} />}>
        <View style={{ paddingTop: spacing.md }}>
          <ListSection footer="Full texts of these open-source licences are available from each project.">
            {NOTICES.map((n) => (
              <ListRow key={n.name} title={n.name} subtitle={`${n.license} — ${n.note}`} />
            ))}
          </ListSection>
        </View>
      </BottomSheet>

      <Modal visible={tourVisible} animationType="slide" onRequestClose={() => setTourVisible(false)}>
        <OnboardingView onDone={() => setTourVisible(false)} />
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  inlineControl: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 8, gap: spacing.md },
  inlineLabel: { ...typography.bodyLarge },
  inlineSegments: { flex: 1 },
  footer: { ...typography.footnote, textAlign: 'center', marginTop: spacing.sm },
});
