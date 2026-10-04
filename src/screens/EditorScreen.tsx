import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  BackHandler,
  SafeAreaView,
  NativeModules,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  EditorScreenNavigationProp,
  EditorScreenRouteProp,
} from '../navigation/types';
import { Header } from '../components/Header';
import { DocumentCanvas } from '../canvas/DocumentCanvas';
import { TextEditModal, TextEditModalConfirmStyle } from '../components/TextEditModal';
import { ExportModal } from '../components/ExportModal';
import { AddedTextElement, Document, TextRegion } from '../types/document';
import { DocumentPoint, ViewportTransform } from '../types/geometry';
import { documentStorage } from '../storage';
import { defaultOcrEngine } from '../features/ocr/engine';
import { defaultReconstructionEngine } from '../features/image/reconstructionEngine';
import { defaultExportEngine, ExportFormat } from '../features/export';
import { DocumentHistoryManager } from '../features/history/historyManager';
import { ImageDocumentSession } from '../features/image/imageDocumentSession';
import { createImageSessionFromDocument } from '../features/image/importService';
import {
  calculateImageInitialFit,
  calculateImageFocalZoom,
  clampImageTranslation,
} from '../features/image/imageViewportMath';
import { colors, radius, spacing, typography } from '../constants/theme';

export const EditorScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<EditorScreenNavigationProp>();
  const route = useRoute<EditorScreenRouteProp>();
  const theme = colors.light;

  const documentId = route.params?.documentId;

  const [document, setDocument] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<TextRegion | null>(null);
  const [selectedAddedText, setSelectedAddedText] = useState<AddedTextElement | null>(null);

  // "+ Text" insert mode state
  const [isInsertMode, setIsInsertMode] = useState(false);
  const [insertLocation, setInsertLocation] = useState<DocumentPoint>({ x: 50, y: 100 });

  // Text edit modal state
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [reconstructing, setReconstructing] = useState(false);

  // Export modal state
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Undo/Redo history manager
  const history = useRef(new DocumentHistoryManager());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateHistoryFlags = useCallback(() => {
    setCanUndo(history.current.canUndo);
    setCanRedo(history.current.canRedo);
  }, []);

  // Viewport transform state
  const [canvasLayout, setCanvasLayout] = useState<{ width: number; height: number } | null>(null);
  const sessionRef = useRef<ImageDocumentSession | null>(null);

  const calculateFitTransform = useCallback(
    (containerW: number, containerH: number, docW: number, docH: number): ViewportTransform | null => {
      if (containerW <= 0 || containerH <= 0 || docW <= 0 || docH <= 0) return null;
      return calculateImageInitialFit({
        viewportWidth: containerW,
        viewportHeight: containerH,
        imageWidth: docW,
        imageHeight: docH,
        padding: 24,
      });
    },
    [],
  );

  const [transform, setTransform] = useState<ViewportTransform>({
    scale: 0.5,
    translateX: 20,
    translateY: 20,
  });

  // Load document on mount or when documentId changes
  useEffect(() => {
    let isMounted = true;

    async function loadDoc() {
      if (!documentId) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setErrorMessage(null);
        setSelectedRegion(null);
        setSelectedAddedText(null);
        setIsInsertMode(false);

        const doc = await documentStorage.getDocument(documentId);
        if (isMounted) {
          if (!doc) {
            setErrorMessage('The requested image document was not found or could not be loaded.');
            setDocument(null);
            return;
          }

          // Ensure local file URI for Skia compatibility
          let activeDoc = doc;
          if (doc.pages.length > 0 && doc.pages[0].originalContent?.assetUri) {
            const rawUri = doc.pages[0].originalContent.assetUri;
            if (rawUri.startsWith('content://') && NativeModules.ImageProcessingModule?.resolveLocalImageUri) {
              try {
                const resolved = await NativeModules.ImageProcessingModule.resolveLocalImageUri(rawUri);
                if (resolved && resolved !== rawUri) {
                  const updatedPages = doc.pages.map((p, idx) =>
                    idx === 0
                      ? {
                          ...p,
                          originalContent: {
                            ...p.originalContent,
                            assetUri: resolved,
                          },
                        }
                      : p,
                  );
                  activeDoc = { ...doc, pages: updatedPages };
                  await documentStorage.saveDocument(activeDoc);
                }
              } catch (e) {
                console.warn('Could not resolve content URI in EditorScreen:', e);
              }
            }
          }

          if (sessionRef.current) {
            sessionRef.current.close();
            sessionRef.current = null;
          }
          sessionRef.current = createImageSessionFromDocument(activeDoc);

          setDocument(activeDoc);
          if (activeDoc && activeDoc.pages.length > 0) {
            const p = activeDoc.pages[0];
            console.log('[PHASE1_IMAGE] IMAGE_DECODE_SUCCESS: ' + p.dimensions.width + 'x' + p.dimensions.height + ' (' + p.originalContent.assetUri + ')');
          }
          history.current.initialize(doc);
          updateHistoryFlags();

          if (doc.pages.length > 0) {
            const pageWidth = doc.pages[0].dimensions.width;
            const initialScale = Math.min(Math.max(340 / pageWidth, 0.2), 1.0);
            setTransform({
              scale: Math.round(initialScale * 100) / 100,
              translateX: 24,
              translateY: 24,
            });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isMounted) {
          setErrorMessage(`Failed to load document: ${msg}`);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadDoc();

    return () => {
      isMounted = false;
      if (sessionRef.current) {
        sessionRef.current.close();
        sessionRef.current = null;
      }
    };
  }, [documentId, updateHistoryFlags]);

  // Back confirmation handler
  const handleBack = useCallback(() => {
    if (isExporting || scanning || reconstructing) {
      return;
    }

    if (canUndo) {
      Alert.alert(
        'Unsaved Changes',
        'You have unsaved edits. Discard changes and return to Home?',
        [
          { text: 'Keep Editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => navigation.goBack() },
        ],
      );
    } else {
      navigation.goBack();
    }
  }, [isExporting, scanning, reconstructing, canUndo, navigation]);

  // Hook up Android hardware back button
  useEffect(() => {
    const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBack();
      return true;
    });
    return () => backSub.remove();
  }, [handleBack]);

  // Run On-Device OCR text detection
  const handleRunOcr = useCallback(async () => {
    if (!document || document.pages.length === 0 || scanning) return;

    try {
      setScanning(true);
      setSelectedRegion(null);
      setSelectedAddedText(null);
      setIsInsertMode(false);

      const page = document.pages[0];
      const imageUri = page.originalContent.assetUri;
      if (!imageUri) {
        throw new Error('No image URI available for text detection');
      }

      const detectedRegions = await defaultOcrEngine.extractTextRegions(imageUri, 0);

      const updatedPages = [...document.pages];
      updatedPages[0] = {
        ...updatedPages[0],
        editableTextRegions: detectedRegions,
      };

      const updatedDoc: Document = {
        ...document,
        metadata: {
          ...document.metadata,
          updatedAt: Date.now(),
        },
        pages: updatedPages,
      };

      await documentStorage.saveDocument(updatedDoc);
      // Detection alone does not mark document dirty or pollute undo history
      setDocument(updatedDoc);

      if (detectedRegions.length === 0) {
        Alert.alert('No Text Detected', 'No readable text was detected in this image.');
      } else {
        Alert.alert(
          'Text Detected',
          `Detected ${detectedRegions.length} text region${
            detectedRegions.length === 1 ? '' : 's'
          }. Tap any text to select it.`,
          [{ text: 'Continue', style: 'default' }],
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Detection Failed', msg || 'Could not detect text from this image.');
    } finally {
      setScanning(false);
    }
  }, [document, scanning, updateHistoryFlags]);

  // Handle Canvas Tap in Insert Mode
  const handleCanvasTapLocation = useCallback((point: DocumentPoint) => {
    setInsertLocation(point);
    setIsInsertMode(true);
    setEditModalVisible(true);
  }, []);

  // Confirm Text Edit or Insert
  const handleConfirmEdit = async (
    newText: string,
    style: TextEditModalConfirmStyle,
  ) => {
    if (!document) return;

    // Case A: Inserting brand new text element
    if (isInsertMode) {
      const fontSize = style.fontSize || 16;
      const charWidth = fontSize * 0.54;
      const estimatedWidth = Math.max(newText.length * charWidth, 40);
      const estimatedHeight = fontSize * 1.25;

      const newElement: AddedTextElement = {
        id: `added-${Date.now()}`,
        pageIndex: 0,
        text: newText,
        bounds: {
          x: Math.round(insertLocation.x),
          y: Math.round(insertLocation.y),
          width: Math.round(estimatedWidth),
          height: Math.round(estimatedHeight),
        },
        style: {
          fontSize: style.fontSize ?? 16,
          color: style.color ?? '#111827',
          fontWeight: style.fontWeight ?? 'normal',
          fontStyle: style.fontStyle ?? 'normal',
        },
      };

      const updatedPages = [...document.pages];
      updatedPages[0] = {
        ...updatedPages[0],
        addedText: [...(updatedPages[0].addedText || []), newElement],
      };

      const updatedDoc: Document = {
        ...document,
        metadata: { ...document.metadata, updatedAt: Date.now() },
        pages: updatedPages,
      };

      await documentStorage.saveDocument(updatedDoc);
      history.current.push(updatedDoc);
      updateHistoryFlags();
      setDocument(updatedDoc);

      setIsInsertMode(false);
      setEditModalVisible(false);
      setSelectedAddedText(newElement);
      return;
    }

    // Case B: Modifying existing detected region
    if (!selectedRegion) return;

    const page = document.pages[0];
    const imageUri = page.originalContent.assetUri;
    if (!imageUri) return;

    try {
      setReconstructing(true);

      const patchResult = await defaultReconstructionEngine.reconstructBackground(
        imageUri,
        selectedRegion.bounds,
      );

      const updatedRegion: TextRegion = {
        ...selectedRegion,
        currentText: newText,
        status: 'modified',
        originalBounds: selectedRegion.originalBounds || selectedRegion.bounds,
        reconstructedPatchUri: patchResult.patchUri,
        reconstructedPatchBounds: patchResult.bounds,
        style: {
          ...selectedRegion.style,
          fontSize: style.fontSize ?? selectedRegion.style.fontSize,
          color: style.color ?? selectedRegion.style.color,
          fontWeight: style.fontWeight ?? selectedRegion.style.fontWeight,
          fontStyle: style.fontStyle ?? selectedRegion.style.fontStyle,
        },
      };

      const updatedRegions = page.editableTextRegions.map((r) =>
        r.id === selectedRegion.id ? updatedRegion : r,
      );

      const updatedPages = [...document.pages];
      updatedPages[0] = {
        ...updatedPages[0],
        editableTextRegions: updatedRegions,
      };

      const updatedDoc: Document = {
        ...document,
        metadata: { ...document.metadata, updatedAt: Date.now() },
        pages: updatedPages,
      };

      await documentStorage.saveDocument(updatedDoc);
      history.current.push(updatedDoc);
      updateHistoryFlags();
      setDocument(updatedDoc);

      setSelectedRegion(updatedRegion);
      setEditModalVisible(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Edit Error', `Failed to edit text: ${msg}`);
    } finally {
      setReconstructing(false);
    }
  };

  // Delete selected OCR text region
  const handleDeleteRegion = async () => {
    if (!document || !selectedRegion) return;

    const page = document.pages[0];
    const imageUri = page.originalContent.assetUri;
    if (!imageUri) return;

    try {
      setReconstructing(true);

      const patchResult = await defaultReconstructionEngine.reconstructBackground(
        imageUri,
        selectedRegion.bounds,
      );

      const updatedRegion: TextRegion = {
        ...selectedRegion,
        currentText: '',
        status: 'deleted',
        originalBounds: selectedRegion.originalBounds || selectedRegion.bounds,
        reconstructedPatchUri: patchResult.patchUri,
        reconstructedPatchBounds: patchResult.bounds,
      };

      const updatedRegions = page.editableTextRegions.map((r) =>
        r.id === selectedRegion.id ? updatedRegion : r,
      );

      const updatedPages = [...document.pages];
      updatedPages[0] = {
        ...updatedPages[0],
        editableTextRegions: updatedRegions,
      };

      const updatedDoc: Document = {
        ...document,
        metadata: { ...document.metadata, updatedAt: Date.now() },
        pages: updatedPages,
      };

      await documentStorage.saveDocument(updatedDoc);
      history.current.push(updatedDoc);
      updateHistoryFlags();
      setDocument(updatedDoc);

      setSelectedRegion(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Delete Error', `Failed to delete text: ${msg}`);
    } finally {
      setReconstructing(false);
    }
  };

  // Delete selected added text element
  const handleDeleteAddedText = async () => {
    if (!document || !selectedAddedText) return;

    const page = document.pages[0];
    const updatedAdded = (page.addedText || []).filter(
      (el) => el.id !== selectedAddedText.id,
    );

    const updatedPages = [...document.pages];
    updatedPages[0] = {
      ...updatedPages[0],
      addedText: updatedAdded,
    };

    const updatedDoc: Document = {
      ...document,
      metadata: { ...document.metadata, updatedAt: Date.now() },
      pages: updatedPages,
    };

    await documentStorage.saveDocument(updatedDoc);
    history.current.push(updatedDoc);
    updateHistoryFlags();
    setDocument(updatedDoc);

    setSelectedAddedText(null);
  };

  // Undo action
  const handleUndo = async () => {
    if (!history.current.canUndo) return;
    const prevDoc = history.current.undo();
    if (prevDoc) {
      await documentStorage.saveDocument(prevDoc);
      updateHistoryFlags();
      setDocument(prevDoc);
      setSelectedRegion(null);
      setSelectedAddedText(null);
    }
  };

  // Redo action
  const handleRedo = async () => {
    if (!history.current.canRedo) return;
    const nextDoc = history.current.redo();
    if (nextDoc) {
      await documentStorage.saveDocument(nextDoc);
      updateHistoryFlags();
      setDocument(nextDoc);
      setSelectedRegion(null);
      setSelectedAddedText(null);
    }
  };

  // Confirm Export
  const handleConfirmExport = async (format: ExportFormat, quality: number) => {
    if (!document) return;

    try {
      setIsExporting(true);
      const result = await defaultExportEngine.exportDocument(document, {
        format,
        quality,
      });

      setExportModalVisible(false);
      Alert.alert('Export Successful', `Image saved successfully to:
${result.destinationUri}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Export Failed', msg || 'Failed to export image.');
    } finally {
      setIsExporting(false);
    }
  };

  // Zoom controls
  const handleZoomIn = () => {
    setTransform((prev) => ({
      ...prev,
      scale: Math.min(Math.round((prev.scale + 0.2) * 100) / 100, 4.5),
    }));
  };

  const handleZoomOut = () => {
    setTransform((prev) => ({
      ...prev,
      scale: Math.max(Math.round((prev.scale - 0.2) * 100) / 100, 0.2),
    }));
  };

  const handleFit = useCallback(() => {
    if (!document || document.pages.length === 0 || !canvasLayout) return;
    const p = document.pages[0];
    const fit = calculateFitTransform(
      canvasLayout.width,
      canvasLayout.height,
      p.dimensions.width,
      p.dimensions.height,
    );
    if (fit) setTransform(fit);
  }, [document, canvasLayout, calculateFitTransform]);

  if (loading) {
    return (
      <View style={[styles.loadingScreen, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textSecondary }]}>
          Loading image...
        </Text>
      </View>
    );
  }

  if (errorMessage || !document || document.pages.length === 0) {
    return (
      <SafeAreaView style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: theme.background }]}>
        <Header title="Image Editor" onBackPress={() => navigation.goBack()} />
        <View style={styles.errorContainer}>
          <Text style={[styles.errorTitle, { color: theme.textPrimary }]}>
            Unable to Load Image
          </Text>
          <Text style={[styles.errorDescription, { color: theme.textSecondary }]}>
            {errorMessage || 'The document could not be opened.'}
          </Text>
          <TouchableOpacity
            style={[styles.primaryActionBtn, { backgroundColor: theme.primary }]}
            onPress={() => navigation.goBack()}>
            <Text style={styles.primaryActionBtnText}>Return to Home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const page = document.pages[0];
  const imageUri = page.originalContent.assetUri;
  const documentWidth = page.dimensions.width;
  const documentHeight = page.dimensions.height;
  const textRegions = page.editableTextRegions || [];
  const addedText = page.addedText || [];

  return (
    <SafeAreaView
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          backgroundColor: theme.background,
        },
      ]}>
      {/* Header Bar - iOS Style */}
      <Header
        title={document.metadata.title}
        onBackPress={handleBack}
        rightAction={
          <View style={styles.headerRightActions}>
            <TouchableOpacity
              style={[styles.historyBtn, !canUndo && styles.btnDisabled]}
              onPress={handleUndo}
              disabled={!canUndo}>
              <Text style={[styles.historyBtnText, { color: canUndo ? theme.textPrimary : theme.textMuted }]}>
                ↶
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.historyBtn, !canRedo && styles.btnDisabled]}
              onPress={handleRedo}
              disabled={!canRedo}>
              <Text style={[styles.historyBtnText, { color: canRedo ? theme.textPrimary : theme.textMuted }]}>
                ↷
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => setExportModalVisible(true)}
              disabled={isExporting}
              style={[styles.exportBtn, { backgroundColor: theme.primary }]}>
              {isExporting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.exportBtnText}>Export</Text>
              )}
            </TouchableOpacity>
          </View>
        }
      />

      {/* Insert mode banner */}
      {isInsertMode && (
        <View style={[styles.banner, { backgroundColor: theme.primarySubtle }]}>
          <Text style={[styles.bannerText, { color: theme.primary }]}>
            Tap anywhere on the image to place text
          </Text>
          <TouchableOpacity onPress={() => setIsInsertMode(false)}>
            <Text style={[styles.bannerCancel, { color: theme.primary }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Scanning banner */}
      {scanning && (
        <View style={[styles.banner, { backgroundColor: '#F0F9FF' }]}>
          <ActivityIndicator size="small" color={theme.primary} style={{ marginRight: 6 }} />
          <Text style={[styles.bannerText, { color: theme.primary }]}>
            Detecting text in image...
          </Text>
        </View>
      )}

      {/* Canvas Area */}
      <View
        style={styles.canvasArea}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width > 0 && height > 0) {
            setCanvasLayout({ width, height });
            if (document && document.pages.length > 0) {
              const p = document.pages[0];
              const fit = calculateFitTransform(width, height, p.dimensions.width, p.dimensions.height);
              if (fit) setTransform(fit);
            }
          }
        }}>
        <DocumentCanvas
          transform={transform}
          onTransformChange={setTransform}
          documentWidth={documentWidth}
          documentHeight={documentHeight}
          imageUri={imageUri}
          textRegions={textRegions}
          addedText={addedText}
          selectedRegionId={selectedRegion?.id}
          selectedAddedTextId={selectedAddedText?.id}
          onSelectRegion={(reg) => {
            setSelectedRegion(reg);
            setSelectedAddedText(null);
            setIsInsertMode(false);
          }}
          onSelectAddedText={(el) => {
            setSelectedAddedText(el);
            setSelectedRegion(null);
            setIsInsertMode(false);
          }}
          onTapLocation={handleCanvasTapLocation}
          isInsertMode={isInsertMode}
        />

        {/* Floating Context Toolbar when Text Region Selected */}
        {selectedRegion && !editModalVisible && (
          <View style={[styles.floatingContextBar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.contextText, { color: theme.textPrimary }]} numberOfLines={1}>
              "{selectedRegion.currentText || selectedRegion.originalText}"
            </Text>
            <View style={styles.contextActions}>
              <TouchableOpacity
                style={[styles.contextBtn, { backgroundColor: theme.primarySubtle }]}
                onPress={() => setEditModalVisible(true)}
                disabled={reconstructing}>
                <Text style={[styles.contextBtnText, { color: theme.primary }]}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.contextBtn, { backgroundColor: '#FEE2E2' }]}
                onPress={handleDeleteRegion}
                disabled={reconstructing}>
                <Text style={[styles.contextBtnText, { color: theme.danger }]}>Delete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.contextClose}
                onPress={() => setSelectedRegion(null)}>
                <Text style={[styles.contextCloseText, { color: theme.textMuted }]}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Floating Context Toolbar when Added Text Selected */}
        {selectedAddedText && !editModalVisible && (
          <View style={[styles.floatingContextBar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.contextText, { color: theme.textPrimary }]} numberOfLines={1}>
              "{selectedAddedText.text}"
            </Text>
            <View style={styles.contextActions}>
              <TouchableOpacity
                style={[styles.contextBtn, { backgroundColor: '#FEE2E2' }]}
                onPress={handleDeleteAddedText}>
                <Text style={[styles.contextBtnText, { color: theme.danger }]}>Delete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.contextClose}
                onPress={() => setSelectedAddedText(null)}>
                <Text style={[styles.contextCloseText, { color: theme.textMuted }]}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* Bottom Tool Bar - Clean iOS controls */}
      <View style={[styles.bottomToolbar, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
        <View style={styles.bottomMainActions}>
          <TouchableOpacity
            style={[styles.toolActionBtn, { backgroundColor: theme.primarySubtle }]}
            onPress={() => setIsInsertMode(!isInsertMode)}>
            <Text style={[styles.toolActionText, { color: theme.primary }]}>
              {isInsertMode ? 'Cancel' : '+ Text'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.toolActionBtn, { backgroundColor: theme.primarySubtle }, scanning && styles.btnDisabled]}
            onPress={handleRunOcr}
            disabled={scanning}>
            <Text style={[styles.toolActionText, { color: theme.primary }]}>
              {scanning ? 'Scanning...' : 'Detect Text'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.zoomControlGroup}>
          <TouchableOpacity
            style={styles.zoomBtn}
            onPress={handleZoomOut}
            accessibilityLabel="Zoom Out">
            <Text style={[styles.zoomBtnText, { color: theme.textPrimary }]}>−</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.zoomBtnFit}
            onPress={handleFit}
            accessibilityLabel="Fit">
            <Text style={[styles.zoomFitText, { color: theme.textSecondary }]}>Fit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.zoomBtn}
            onPress={handleZoomIn}
            accessibilityLabel="Zoom In">
            <Text style={[styles.zoomBtnText, { color: theme.textPrimary }]}>+</Text>
          </TouchableOpacity>

          <Text style={[styles.zoomLevelText, { color: theme.textMuted }]}>
            {Math.round(transform.scale * 100)}%
          </Text>
        </View>
      </View>

      {/* Text Editing Bottom Sheet / Modal */}
      <TextEditModal
        visible={editModalVisible}
        initialText={isInsertMode ? '' : selectedRegion?.currentText || selectedRegion?.originalText || ''}
        initialStyle={selectedRegion?.style}
        isProcessing={reconstructing}
        isInsertMode={isInsertMode}
        onConfirm={handleConfirmEdit}
        onCancel={() => {
          setEditModalVisible(false);
          setIsInsertMode(false);
        }}
      />

      {/* Export Modal */}
      <ExportModal
        visible={exportModalVisible}
        documentWidth={documentWidth}
        documentHeight={documentHeight}
        isExporting={isExporting}
        onExport={handleConfirmExport}
        onCancel={() => setExportModalVisible(false)}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    ...typography.caption,
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.sm,
  },
  errorTitle: {
    ...typography.titleMedium,
  },
  errorDescription: {
    ...typography.bodyMedium,
    textAlign: 'center',
    maxWidth: 280,
    marginBottom: spacing.md,
  },
  primaryActionBtn: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  primaryActionBtnText: {
    color: '#FFFFFF',
    ...typography.titleSmall,
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  historyBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyBtnText: {
    fontSize: 18,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.35,
  },
  exportBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    marginLeft: spacing.xs,
  },
  exportBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bannerText: {
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  bannerCancel: {
    fontSize: 13,
    fontWeight: '600',
    marginLeft: spacing.md,
  },
  canvasArea: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  floatingContextBar: {
    position: 'absolute',
    bottom: spacing.lg,
    left: spacing.lg,
    right: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    shadowColor: 'rgba(0, 0, 0, 0.1)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  contextText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    marginRight: spacing.md,
  },
  contextActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  contextBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
  },
  contextBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  contextClose: {
    padding: spacing.xs,
    marginLeft: 2,
  },
  contextCloseText: {
    fontSize: 14,
    fontWeight: '500',
  },
  bottomToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bottomMainActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  toolActionBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.md,
  },
  toolActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  zoomControlGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  zoomBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: '#F2F2F7',
  },
  zoomBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  zoomBtnFit: {
    paddingHorizontal: 8,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: '#F2F2F7',
    marginHorizontal: 2,
  },
  zoomFitText: {
    fontSize: 11,
    fontWeight: '600',
  },
  zoomLevelText: {
    fontSize: 11,
    fontWeight: '500',
    marginLeft: spacing.xs,
    minWidth: 32,
    textAlign: 'right',
  },
});
