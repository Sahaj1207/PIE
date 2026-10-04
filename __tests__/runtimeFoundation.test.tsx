import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules, View } from 'react-native';

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureHandlerRootView: (props: any) => <View testID="GestureHandlerRootView" {...props} />,
  };
});

jest.mock('react-native-reanimated', () => ({
  useSharedValue: (init: any) => ({ value: init }),
}));

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    NavigationContainer: ({ children, onReady }: any) => {
      React.useEffect(() => {
        onReady?.();
      }, [onReady]);
      return children;
    },
    useNavigation: () => ({
      navigate: jest.fn(),
      goBack: jest.fn(),
    }),
    useIsFocused: () => true,
    useRoute: () => ({ params: {} }),
  };
});

jest.mock('../src/navigation/RootNavigator', () => ({
  RootNavigator: () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../src/storage', () => ({
  documentStorage: {
    listDocuments: jest.fn().mockResolvedValue([]),
    getDocument: jest.fn().mockResolvedValue(null),
    saveDocument: jest.fn().mockResolvedValue(undefined),
  },
}));

import { App } from '../src/app/App';

describe('Phase 0: Runtime Foundation Verification', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    NativeModules.PdfiumNativeModule = {
      pickPdfDocument: jest.fn(),
      renderPage: jest.fn(),
      getPageCount: jest.fn(),
      getTextObjects: jest.fn(),
    };
    NativeModules.ImageProcessingModule = {
      resolveLocalImageUri: jest.fn(),
      pickImageDocument: jest.fn(),
    };
    NativeModules.OcrNativeModule = {
      recognizeText: jest.fn(),
    };
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('renders GestureHandlerRootView at the top level of the component tree', async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<App />);
    });

    const root = renderer!.root;
    const ghRoot = root.findByProps({ testID: 'GestureHandlerRootView' });
    expect(ghRoot).toBeDefined();
    expect(ghRoot.props.style).toEqual({ flex: 1 });
  });

  it('emits all Phase 0 runtime diagnostic logs on launch', async () => {
    await act(async () => {
      ReactTestRenderer.create(<App />);
    });

    const loggedMessages = logSpy.mock.calls.map((c) => c[0]);

    expect(loggedMessages).toContain('[RUNTIME_DIAGNOSTIC] APP_STARTED');
    expect(loggedMessages).toContain('[RUNTIME_DIAGNOSTIC] GESTURE_ROOT_READY');
    expect(loggedMessages).toContain('[RUNTIME_DIAGNOSTIC] REANIMATED_READY');
    expect(loggedMessages).toContain('[RUNTIME_DIAGNOSTIC] PDF_NATIVE_MODULE_READY');
    expect(loggedMessages).toContain('[RUNTIME_DIAGNOSTIC] IMAGE_NATIVE_MODULE_READY');
    expect(loggedMessages).toContain('[RUNTIME_DIAGNOSTIC] OCR_NATIVE_MODULE_READY');
    expect(loggedMessages).toContain('[RUNTIME_DIAGNOSTIC] NAVIGATION_READY');
  });

  it('verifies native module presence contract', () => {
    expect(NativeModules.PdfiumNativeModule).toBeDefined();
    expect(NativeModules.ImageProcessingModule).toBeDefined();
    expect(NativeModules.OcrNativeModule).toBeDefined();
  });
});
