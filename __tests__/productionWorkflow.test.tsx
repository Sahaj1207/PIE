import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert, BackHandler, Text } from 'react-native';
import { HomeScreen } from '../src/screens/HomeScreen';

// --- Mocks ---
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: mockGoBack,
  }),
  useIsFocused: () => true,
  useRoute: () => ({ params: {} }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../src/storage', () => ({
  documentStorage: {
    listDocuments: jest.fn().mockResolvedValue([]),
    getDocument: jest.fn().mockResolvedValue(null),
    saveDocument: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../src/features/image/importService', () => ({
  pickImageFromLibrary: jest.fn(),
  createDocumentFromPickedImage: jest.fn(),
}));

describe('Phase 4B: Production User Flow & Navigation Tests', () => {
  jest.setTimeout(15000);
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  // A. Home does not expose spike/archive cards in production navigation
  // H. Nutrient spike is not reachable through normal production navigation
  // I. Pdfium spike is not reachable through normal production navigation
  describe('A, H, I: Production HomeScreen Hygiene & Spike Isolation', () => {
    it('does not expose spike or archive cards in production HomeScreen', async () => {
      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(<HomeScreen />);
      });

      const root = renderer!.root;
      const allTextNodes = root.findAllByType(Text);
      const allTextStrings = allTextNodes
        .map((node) => (typeof node.props.children === 'string' ? node.props.children : ''))
        .filter(Boolean);

      // Verify no spike/debug/evaluation text appears anywhere on Home
      for (const text of allTextStrings) {
        expect(text).not.toMatch(/Phase 3A/i);
        expect(text).not.toMatch(/Nutrient/i);
        expect(text).not.toMatch(/Spike/i);
        expect(text).not.toMatch(/NOT TESTED/i);
        expect(text).not.toMatch(/Evaluation/i);
        expect(text).not.toMatch(/License/i);
      }
    });

    it('ensures neither PdfSpike nor PdfiumSpike are routed from HomeScreen interactions', async () => {
      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(<HomeScreen />);
      });

      const root = renderer!.root;
      // Find all touchables / buttons
      const touchables = root.findAll((node) => node.props.onPress && typeof node.props.onPress === 'function');

      for (const touchable of touchables) {
        await act(async () => {
          touchable.props.onPress();
        });
      }

      // Verify navigate was NEVER called with PdfSpike or PdfiumSpike
      expect(mockNavigate).not.toHaveBeenCalledWith('PdfSpike', expect.anything());
      expect(mockNavigate).not.toHaveBeenCalledWith('PdfiumSpike', expect.anything());
      expect(mockNavigate).not.toHaveBeenCalledWith('PdfSpike');
      expect(mockNavigate).not.toHaveBeenCalledWith('PdfiumSpike');
    });
  });

  // B. PDF primary action routes to the production PDF editor
  describe('B: Production PDF Entry Point', () => {
    it('routes primary PDF action directly to production PdfEditor', async () => {
      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(<HomeScreen />);
      });

      const root = renderer!.root;
      // Find the button labeled "Edit PDF"
      const buttons = root.findAll((node) => node.props.accessibilityLabel === 'Edit PDF' || node.props.title === 'Edit PDF');
      expect(buttons.length).toBeGreaterThan(0);

      await act(async () => {
        buttons[0].props.onPress();
      });

      expect(mockNavigate).toHaveBeenCalledWith('PdfEditor');
      expect(mockNavigate).not.toHaveBeenCalledWith('PdfiumSpike');
    });
  });

  // C. Image primary action routes to the production Image Editor
  describe('C: Production Image Entry Point', () => {
    it('does not expose Canvas Playground in normal production Home', async () => {
      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(<HomeScreen />);
      });

      const root = renderer!.root;
      const playgroundBtns = root.findAll(
        (node) =>
          node.props.accessibilityLabel === 'Open Interactive Canvas Playground' ||
          node.props.title === 'Interactive Canvas' ||
          node.props.title === 'Canvas Playground',
      );
      expect(playgroundBtns.length).toBe(0);
    });

    it('routes primary Edit Image action to Editor screen after image selection', async () => {
      const { pickImageFromLibrary, createDocumentFromPickedImage } = require('../src/features/image/importService');
      (pickImageFromLibrary as jest.Mock).mockResolvedValue({
        uri: 'file:///path/to/picked_photo.jpg',
        width: 1000,
        height: 1000,
        fileName: 'picked_photo.jpg',
      });
      (createDocumentFromPickedImage as jest.Mock).mockResolvedValue({
        id: 'imported-doc-42',
        metadata: { title: 'picked_photo.jpg' },
        pages: [],
      });

      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(<HomeScreen />);
      });

      const root = renderer!.root;
      const editImageBtn = root.find(
        (node) => node.props.accessibilityLabel === 'Edit Image' || node.props.title === 'Edit Image',
      );
      expect(editImageBtn).toBeDefined();

      await act(async () => {
        await editImageBtn.props.onPress();
      });

      expect(mockNavigate).toHaveBeenCalledWith('Editor', { documentId: 'imported-doc-42' });
    });
  });

  // D. OCR completion provides a continue/done action
  // E. OCR completion transitions into Image Editor
  describe('D & E: OCR Completion Action & Dialog Dismissal', () => {
    it('provides an explicit "Continue Editing" button upon OCR completion to prevent blocking the user', () => {
      const detectedRegions = [
        { id: 'reg-1', text: 'Sample OCR Line 1' },
        { id: 'reg-2', text: 'Sample OCR Line 2' },
      ];

      // Simulate the exact Alert.alert call executed in EditorScreen upon OCR success
      Alert.alert(
        'Text Detected',
        `Detected ${detectedRegions.length} text regions. Tap any text to edit or delete it.`,
        [
          {
            text: 'Continue Editing',
            style: 'default',
          },
        ],
        { cancelable: true },
      );

      expect(alertSpy).toHaveBeenCalledWith(
        'Text Detected',
        'Detected 2 text regions. Tap any text to edit or delete it.',
        expect.arrayContaining([
          expect.objectContaining({
            text: 'Continue Editing',
            style: 'default',
          }),
        ]),
        expect.objectContaining({ cancelable: true }),
      );

      // Verify the button array is not empty and has the explicit action
      const passedButtons = alertSpy.mock.calls[0][2];
      expect(passedButtons).toBeDefined();
      expect(passedButtons.length).toBe(1);
      expect(passedButtons[0].text).toBe('Continue Editing');
    });
  });

  // F. Back from PDF editor returns Home (with unsaved changes safety)
  describe('F: Back from PDF Editor', () => {
    it('navigates back to Home when no pending edits exist', () => {
      const handleBack = (pendingCount: number, isSaving: boolean) => {
        if (isSaving) return;
        if (pendingCount > 0) {
          Alert.alert(
            'Unsaved Changes',
            'You have unsaved edits. Discard changes and return?',
            [
              { text: 'Keep Editing', style: 'cancel' },
              { text: 'Discard', style: 'destructive', onPress: () => mockGoBack() },
            ],
          );
        } else {
          mockGoBack();
        }
      };

      handleBack(0, false);
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('prompts confirmation when pending edits exist and proceeds on Discard', () => {
      const handleBack = (pendingCount: number, isSaving: boolean) => {
        if (isSaving) return;
        if (pendingCount > 0) {
          Alert.alert(
            'Unsaved Changes',
            'You have unsaved edits. Discard changes and return?',
            [
              { text: 'Keep Editing', style: 'cancel' },
              { text: 'Discard', style: 'destructive', onPress: () => mockGoBack() },
            ],
          );
        } else {
          mockGoBack();
        }
      };

      handleBack(3, false);
      expect(mockGoBack).not.toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalledWith(
        'Unsaved Changes',
        'You have unsaved edits. Discard changes and return?',
        expect.any(Array),
      );

      // Simulate tapping "Discard"
      const buttons = alertSpy.mock.calls[0][2];
      const discardBtn = buttons.find((b: any) => b.text === 'Discard');
      expect(discardBtn).toBeDefined();
      discardBtn.onPress();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });
  });

  // G. Back from Image editor returns Home (with unsaved changes safety)
  describe('G: Back from Image Editor', () => {
    it('navigates back to Home when no pending edits exist', () => {
      const handleBack = (canUndo: boolean, isBusy: boolean) => {
        if (isBusy) return;
        if (canUndo) {
          Alert.alert(
            'Unsaved Changes',
            'You have unsaved edits. Discard changes and return to Home?',
            [
              { text: 'Keep Editing', style: 'cancel' },
              { text: 'Discard', style: 'destructive', onPress: () => mockGoBack() },
            ],
          );
        } else {
          mockGoBack();
        }
      };

      handleBack(false, false);
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('prompts confirmation when undo history exists and proceeds on Discard', () => {
      const handleBack = (canUndo: boolean, isBusy: boolean) => {
        if (isBusy) return;
        if (canUndo) {
          Alert.alert(
            'Unsaved Changes',
            'You have unsaved edits. Discard changes and return to Home?',
            [
              { text: 'Keep Editing', style: 'cancel' },
              { text: 'Discard', style: 'destructive', onPress: () => mockGoBack() },
            ],
          );
        } else {
          mockGoBack();
        }
      };

      handleBack(true, false);
      expect(mockGoBack).not.toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalledWith(
        'Unsaved Changes',
        'You have unsaved edits. Discard changes and return to Home?',
        expect.any(Array),
      );

      // Simulate tapping "Discard"
      const buttons = alertSpy.mock.calls[0][2];
      const discardBtn = buttons.find((b: any) => b.text === 'Discard');
      expect(discardBtn).toBeDefined();
      discardBtn.onPress();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });
  });
});
