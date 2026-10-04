import React, { useEffect } from 'react';
import { StatusBar, NativeModules } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { useSharedValue } from 'react-native-reanimated';
import { RootNavigator } from '../navigation/RootNavigator';

export const App: React.FC = () => {
  // Reanimated initialization check
  const sharedVal = useSharedValue(1);

  useEffect(() => {
    // Phase 0: Foundational Runtime Diagnostics (logged to Android Logcat / ReactNativeJS)
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
  }, [sharedVal]);

  const handleNavigationReady = () => {
    console.log('[RUNTIME_DIAGNOSTIC] NAVIGATION_READY');
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" />
        <NavigationContainer onReady={handleNavigationReady}>
          <RootNavigator />
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

export default App;
