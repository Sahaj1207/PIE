import React, { useEffect, useMemo } from 'react';
import { NativeModules } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { useSharedValue } from 'react-native-reanimated';
import { RootNavigator } from '../navigation/RootNavigator';
import { cleanupStaleEditingSessions } from '../storage/documentFiles';
import { defaultPdfiumEngine } from '../features/pdf/pdfiumEngine';
import { SHARE_COPY_RETENTION_MS } from '../features/pdf/pdfLibrary';
import { purgePdfThumbnails } from '../features/pdf/pdfDocumentOperations';
import { appSettings } from '../settings/appSettings';
import { ThemeProvider, useTheme } from '../ui/ThemeProvider';
import { OverlayHost } from '../ui/overlays';
import { ErrorBoundary } from '../ui/controls';
import { OnboardingGate } from '../screens/OnboardingScreen';

const AppNavigation: React.FC = () => {
  const { dark, colors } = useTheme();
  const navTheme = useMemo(() => {
    // Defensive: the navigation themes are absent in some test mocks.
    const base: any = (dark ? DarkTheme : DefaultTheme) ?? { dark, colors: {} };
    return {
      ...base,
      colors: {
        ...(base.colors ?? {}),
        primary: colors.primary,
        background: colors.groupedBackground,
        card: colors.bar,
        text: colors.textPrimary,
        border: colors.separator,
      },
    };
  }, [dark, colors]);

  const handleNavigationReady = () => {
    console.log('[RUNTIME_DIAGNOSTIC] NAVIGATION_READY');
  };

  return (
    <NavigationContainer theme={navTheme} onReady={handleNavigationReady}>
      <ErrorBoundary>
        <RootNavigator />
      </ErrorBoundary>
    </NavigationContainer>
  );
};

export const App: React.FC = () => {
  // Reanimated initialization check
  const sharedVal = useSharedValue(1);

  useEffect(() => {
    // Foundational runtime diagnostics (Android Logcat / ReactNativeJS)
    console.log('[RUNTIME_DIAGNOSTIC] APP_STARTED');
    console.log('[RUNTIME_DIAGNOSTIC] GESTURE_ROOT_READY');

    if (sharedVal && typeof sharedVal.value === 'number') {
      console.log('[RUNTIME_DIAGNOSTIC] REANIMATED_READY');
    } else {
      console.warn('[RUNTIME_DIAGNOSTIC] REANIMATED_FAIL: SharedValue not initialized');
    }

    if (NativeModules.PdfiumNativeModule) {
      console.log('[RUNTIME_DIAGNOSTIC] PDF_NATIVE_MODULE_READY');
    } else {
      console.warn('[RUNTIME_DIAGNOSTIC] PDF_NATIVE_MODULE_FAIL: NativeModules.PdfiumNativeModule not found');
    }

    if (NativeModules.ImageProcessingModule) {
      console.log('[RUNTIME_DIAGNOSTIC] IMAGE_NATIVE_MODULE_READY');
    } else {
      console.warn('[RUNTIME_DIAGNOSTIC] IMAGE_NATIVE_MODULE_FAIL: NativeModules.ImageProcessingModule not found');
    }

    if (NativeModules.OcrNativeModule) {
      console.log('[RUNTIME_DIAGNOSTIC] OCR_NATIVE_MODULE_READY');
    } else {
      console.warn('[RUNTIME_DIAGNOSTIC] OCR_NATIVE_MODULE_FAIL: NativeModules.OcrNativeModule not found');
    }

    // Preferences (appearance, library layout, export defaults).
    appSettings.load();

    // Remove unsaved image-editing session files left by a previous process.
    // Runs once at launch, before any editor session can exist.
    cleanupStaleEditingSessions().catch((e: unknown) => {
      console.warn('[PHASE10_STORAGE] Stale session cleanup failed:', e);
    });

    // Remove obsolete PDF picker/content-URI cache copies left by a previous process.
    // Imported PDFs are copied into durable document storage, so nothing open or persisted
    // references these files at launch.
    defaultPdfiumEngine.purgeImportCache([]).catch(() => 0);
    // Old share copies (cacheDir/pdf_exports); recent ones may still be read by another app.
    defaultPdfiumEngine.purgeExportCache(SHARE_COPY_RETENTION_MS).catch(() => 0);
    // Page thumbnails / image staging files of a previous process.
    purgePdfThumbnails().catch(() => {});
  }, [sharedVal]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppNavigation />
          <OnboardingGate />
          <OverlayHost />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

export default App;
