import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  BackHandler,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  EditorScreenNavigationProp,
  EditorScreenRouteProp,
} from '../navigation/types';
import { DocumentCanvas, LiveDrawing } from '../canvas/DocumentCanvas';
import {
  TextEditModal,
  TextEditModalConfirmStyle,
  documentPixelsPerPoint,
} from '../components/TextEditModal';
import { ExportModal, ExportAction } from '../components/ExportModal';
import { AddedTextElement, Document, TextRegion } from '../types/document';
import { DocumentPoint, ViewportTransform } from '../types/geometry';
import { documentStorage } from '../storage';
import {
  discardEditingSessionFiles,
  getSessionPatchDirectory,
  pruneUnreferencedDocumentFiles,
} from '../storage/documentFiles';
import { defaultOcrEngine } from '../features/ocr/engine';
import { defaultReconstructionEngine } from '../features/image/reconstructionEngine';
import { defaultExportEngine, ExportFormat, ExportResult } from '../features/export';
import { DocumentHistoryManager } from '../features/history/historyManager';
import { ImageDocumentSession } from '../features/image/imageDocumentSession';
import { createImageSessionFromDocument } from '../features/image/importService';
import {
  calculateImageInitialFit,
  resolveImageZoomBounds,
} from '../features/image/imageViewportMath';
import {
  applyOcrDetection,
  createOcrRunToken,
  fingerprintImageDocument,
  isImageDocumentDirty,
} from '../features/image/imageDocumentState';
import {
  createAddedText,
  deleteAddedText,
  manipulateAddedText,
  updateAddedText,
} from '../features/image/addedTextLayers';
import {
  ImageCanvasHit,
  MIN_ADDED_TEXT_FONT_SIZE,
  maxAddedTextFontSize,
  resolveImageCanvasTap,
} from '../features/image/imageCanvasInteraction';
import { defaultTextMeasurer } from '../features/image/textMeasurement';
import {
  CROP_ASPECTS,
  addImageDrawings,
  applyTransformedImage,
  collectImageText,
  fitAspectRect,
  normalizeCropRect,
  pageHasEdits,
  signatureDrawing,
  toImageDrawings,
  transformImageFile,
  ImageTransformRequest,
} from '../features/image/imageMarkup';
import { documentActivity } from '../features/documents/documentActivity';
import {
  HIGHLIGHTER_COLORS,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTH_FACTOR,
  MARKUP_WIDTHS,
  MarkupDrawing,
  MarkupTool,
  drawingFromGesture,
  previewCommands,
} from '../features/markup/markupModel';
import { Point } from '../features/markup/inkPath';
import { SavedSignature } from '../features/markup/signatureStore';
import { fontWeights, spacing, typography } from '../constants/theme';
import { useTheme } from '../ui/ThemeProvider';
import { BackButton, BarButton, EmptyState, NavBar, PillButton, Toolbar, ToolbarItem } from '../ui/controls';
import { confirmAction, showActionSheet, showAlert, showToast } from '../ui/overlays';
import { haptic } from '../ui/haptics';
import { copyText, shareText } from '../ui/clipboard';
import { EditMenu, EditMenuItem, HintPill } from '../ui/EditMenu';
import { appSettings, useAppSettings } from '../settings/appSettings';
import { MarkupToolbar } from '../components/markup/MarkupToolbar';
import { SignatureSheet } from '../components/markup/SignatureSheet';
import { InkLayer } from '../components/markup/InkLayer';
import { CropOverlay, PlacementBox, ScreenRect } from '../components/markup/ScreenOverlays';
import { fitStrokesInto } from '../features/markup/inkPath';

type EditorMode = 'view' | 'insert' | 'markup' | 'crop' | 'placeSignature';

export const EditorScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<EditorScreenNavigationProp>();
  const route = useRoute<EditorScreenRouteProp>();
  const { colors } = useTheme();
  const settings = useAppSettings();

  const documentId = route.params?.documentId;

  const [document, setDocument] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // "Tap text to edit" coach mark after a detection, until the user selects something
  const [ocrHintVisible, setOcrHintVisible] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<TextRegion | null>(null);
  const [selectedAddedText, setSelectedAddedText] = useState<AddedTextElement | null>(null);

  // Interaction mode ("+ Text" insert, markup, crop, signature placement)
  const [mode, setMode] = useState<EditorMode>('view');
  const isInsertMode = mode === 'insert';
  const [insertLocation, setInsertLocation] = useState<DocumentPoint>({ x: 50, y: 100 });
  // True once the text modal is inserting a new layer (survives leaving insert mode)
  const [modalInsert, setModalInsert] = useState(false);

  // Text edit modal state
  const [editModalVisible, setEditModalVisible] = useState(false);
  // True while the modal edits the selected added-text layer (not an OCR region)
  const [isEditingAddedText, setIsEditingAddedText] = useState(false);
  const [reconstructing, setReconstructing] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  // Export modal state
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Markup
  const [markupTool, setMarkupTool] = useState<MarkupTool>('pen');
  const [markupColor, setMarkupColor] = useState<string>(settings.markupColor);
  const [markupWidthIndex, setMarkupWidthIndex] = useState(1);
  const [drawings, setDrawings] = useState<MarkupDrawing[]>([]);
  const [livePoints, setLivePoints] = useState<Point[]>([]);
  const livePointsRef = useRef<Point[]>([]);
  const liveFrameRef = useRef<number | null>(null);

  // Signature placement / crop (screen space)
  const [signaturesVisible, setSignaturesVisible] = useState(false);
  const [placingSignature, setPlacingSignature] = useState<SavedSignature | null>(null);
  const [placementRect, setPlacementRect] = useState<ScreenRect | null>(null);
  const [cropRect, setCropRect] = useState<ScreenRect | null>(null);
  const [cropAspect, setCropAspect] = useState<number | null>(null);

  // Undo/Redo history manager (single canonical image history: Document snapshots)
  const history = useRef(new DocumentHistoryManager());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateHistoryFlags = useCallback(() => {
    setCanUndo(history.current.canUndo);
    setCanRedo(history.current.canRedo);
  }, []);

  // Save / dirty state. The fingerprint of the last persisted document is the baseline;
  // the ImageDocumentSession dirty state is the single dirty authority.
  const savedFingerprintRef = useRef<string>('');
  const dirtyRef = useRef(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const allowLeaveRef = useRef(false);
  const isMountedRef = useRef(true);
  const documentRef = useRef<Document | null>(null);
  documentRef.current = document;

  // Unsaved reconstruction patches of this editing session live here (app-private).
  const sessionPatchDirRef = useRef<string | null>(null);

  // Viewport transform state (never persisted)
  const [canvasLayout, setCanvasLayout] = useState<{ width: number; height: number } | null>(null);
  const [fitScale, setFitScale] = useState<number | null>(null);
  const sessionRef = useRef<ImageDocumentSession | null>(null);

  const zoomBounds = useMemo(
    () => resolveImageZoomBounds(fitScale ?? NaN),
    [fitScale],
  );

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

  /** Recomputes dirty state of `doc` against the last saved baseline. */
  const syncDirtyState = useCallback((doc: Document) => {
    const dirty = isImageDocumentDirty(doc, savedFingerprintRef.current);
    dirtyRef.current = dirty;
    setIsDirty(dirty);
    const session = sessionRef.current;
    if (session && !session.isClosed()) {
      session.markDirty(dirty);
    }
  }, []);

  /** Applies a user edit: one undoable history step, in-memory only until Save. */
  const commitEdit = useCallback(
    (nextDoc: Document) => {
      history.current.push(nextDoc);
      updateHistoryFlags();
      documentRef.current = nextDoc;
      setDocument(nextDoc);
      syncDirtyState(nextDoc);
    },
    [updateHistoryFlags, syncDirtyState],
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
    };
  }, []);

  // The open image counts as "in use" (library delete / rename are refused meanwhile).
  useEffect(() => {
    if (!documentId) return;
    const release = documentActivity.markActive(documentId, 'open');
    return release;
  }, [documentId]);

  // Load document on mount or when documentId changes
  useEffect(() => {
    let isMounted = true;
    allowLeaveRef.current = false;

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
        setMode('view');

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

          sessionPatchDirRef.current = await getSessionPatchDirectory(activeDoc.id).catch(
            (e: unknown) => {
              console.warn('[PHASE10_IMAGE] Session patch directory unavailable:', e);
              return null;
            },
          );
          if (!isMounted) return;

          documentRef.current = activeDoc;
          setDocument(activeDoc);
          if (activeDoc && activeDoc.pages.length > 0) {
            const p = activeDoc.pages[0];
            console.log('[PHASE1_IMAGE] IMAGE_DECODE_SUCCESS: ' + p.dimensions.width + 'x' + p.dimensions.height + ' (' + p.originalContent.assetUri + ')');
          }

          // History baseline is the resolved document actually shown to the user.
          history.current.initialize(activeDoc);
          updateHistoryFlags();
          savedFingerprintRef.current = fingerprintImageDocument(activeDoc);
          syncDirtyState(activeDoc);

          const unavailablePatches = (activeDoc.pages[0]?.editableTextRegions || []).filter(
            (r) => r.patchUnavailable,
          ).length;
          if (unavailablePatches > 0) {
            showAlert(
              'Some Edits Need Attention',
              `${unavailablePatches} edited region${unavailablePatches === 1 ? '' : 's'} could not restore its background patch. Edit or delete the region again to regenerate it.`,
            );
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
      sessionPatchDirRef.current = null;
      if (documentId) {
        // Editing session ended: drop unsaved session patches, then prune document
        // patch files the persisted document no longer references.
        const endedId = documentId;
        discardEditingSessionFiles(endedId)
          .then(() => pruneUnreferencedDocumentFiles(endedId, documentStorage))
          .catch((e: unknown) => console.warn('[PHASE10_IMAGE] Session cleanup failed:', e));
      }
    };
  }, [documentId, updateHistoryFlags, syncDirtyState]);

  // Fit the image whenever the canvas size or the image dimensions change (load, rotate, crop).
  const pageWidth = document?.pages[0]?.dimensions.width ?? 0;
  const pageHeight = document?.pages[0]?.dimensions.height ?? 0;
  const handleFit = useCallback(() => {
    if (!canvasLayout || pageWidth <= 0 || pageHeight <= 0) return;
    const fit = calculateFitTransform(canvasLayout.width, canvasLayout.height, pageWidth, pageHeight);
    if (fit) {
      setFitScale(fit.scale);
      setTransform(fit);
    }
  }, [canvasLayout, pageWidth, pageHeight, calculateFitTransform]);

  useEffect(() => {
    handleFit();
  }, [handleFit]);

  // Persist the current document (explicit Save). Returns true when nothing is unsaved.
  const handleSave = useCallback(async (): Promise<boolean> => {
    const current = documentRef.current;
    if (!current || isSavingRef.current) return false;
    if (!dirtyRef.current) return true;

    isSavingRef.current = true;
    setIsSaving(true);
    const session = sessionRef.current;
    if (session && !session.isClosed()) {
      session.setDirtyState('SAVING');
    }

    try {
      const toSave: Document = {
        ...current,
        metadata: { ...current.metadata, updatedAt: Date.now() },
      };
      await documentStorage.saveDocument(toSave);

      savedFingerprintRef.current = fingerprintImageDocument(toSave);
      documentRef.current = toSave;
      if (isMountedRef.current) {
        setDocument(toSave);
      }
      syncDirtyState(toSave);
      showToast('Saved', { tone: 'success' });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (session && !session.isClosed()) {
        session.setDirtyState('SAVE_FAILED');
      }
      showAlert('Save Failed', `Your edits were not saved and remain open for editing.\n\n${msg}`);
      return false;
    } finally {
      isSavingRef.current = false;
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [syncDirtyState]);

  // -------------------------------------------------------------------------
  // Modes
  // -------------------------------------------------------------------------

  const exitMode = useCallback(() => {
    setMode('view');
    setDrawings([]);
    setLivePoints([]);
    setPlacingSignature(null);
    setPlacementRect(null);
    setCropRect(null);
  }, []);

  const cancelMarkup = useCallback(() => {
    if (drawings.length === 0) {
      exitMode();
      return;
    }
    showAlert('Discard Markup?', 'Your drawings will be removed.', [
      { text: 'Keep Drawing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: exitMode },
    ]);
  }, [drawings.length, exitMode]);

  // Back navigation: the beforeRemove guard below owns the unsaved-changes prompt.
  const handleBack = useCallback(() => {
    if (isExporting || scanning || reconstructing || isSaving || busyLabel) {
      return;
    }
    if (mode === 'markup') {
      cancelMarkup();
      return;
    }
    if (mode !== 'view') {
      exitMode();
      return;
    }
    navigation.goBack();
  }, [isExporting, scanning, reconstructing, isSaving, busyLabel, mode, cancelMarkup, exitMode, navigation]);

  // Hook up Android hardware back button
  useEffect(() => {
    const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBack();
      return true;
    });
    return () => backSub.remove();
  }, [handleBack]);

  // React Navigation beforeRemove guard (header back, hardware back, gestures)
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (allowLeaveRef.current || !dirtyRef.current) {
        return;
      }
      e.preventDefault();

      showAlert('Unsaved Changes', 'Do you want to save the changes you made to this image?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: "Don't Save",
          style: 'destructive',
          onPress: () => {
            // Nothing was persisted since the last Save, so leaving discards the edits.
            allowLeaveRef.current = true;
            navigation.dispatch(e.data.action);
          },
        },
        {
          text: 'Save',
          onPress: async () => {
            const saved = await handleSave();
            if (saved) {
              allowLeaveRef.current = true;
              navigation.dispatch(e.data.action);
            }
          },
        },
      ]);
    });
    return unsubscribe;
  }, [navigation, handleSave]);

  // -------------------------------------------------------------------------
  // OCR
  // -------------------------------------------------------------------------

  // Run On-Device OCR text detection (undoable document edit; preserves existing edits)
  const handleRunOcr = useCallback(async () => {
    if (!document || document.pages.length === 0 || scanning) return;

    try {
      setScanning(true);
      setSelectedRegion(null);
      setSelectedAddedText(null);
      setMode('view');

      const page = document.pages[0];
      const imageUri = page.originalContent.assetUri;
      if (!imageUri) {
        throw new Error('No image URI available for text detection');
      }

      // The upright document size enables on-device OCR preprocessing and keeps the
      // detected regions in document coordinates.
      const detectedRegions = await defaultOcrEngine.extractTextRegions(imageUri, 0, {
        imageSize: page.dimensions,
      });

      // Merge against the latest document (edits may not be replaced or duplicated).
      const baseDoc = documentRef.current || document;
      const updatedDoc = applyOcrDetection(baseDoc, detectedRegions, createOcrRunToken(), 0);
      commitEdit(updatedDoc);

      const detectedCount = (updatedDoc.pages[0]?.editableTextRegions || []).filter(
        (r) => r.status === 'detected',
      ).length;

      if (detectedCount === 0) {
        showAlert(
          'No Text Found',
          'No readable text was found in this image. Text recognition works best with clear, printed Latin-script text.',
        );
      } else {
        showToast(`Found ${detectedCount} text ${detectedCount === 1 ? 'block' : 'blocks'}`, { icon: 'scanText' });
        setOcrHintVisible(true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Text Detection Failed', msg || 'Could not detect text in this image.');
    } finally {
      setScanning(false);
    }
  }, [document, scanning, commitEdit]);

  // Handle Canvas Tap in Insert Mode
  const handleCanvasTapLocation = useCallback((point: DocumentPoint) => {
    setInsertLocation(point);
    setMode('view');
    setModalInsert(true);
    setEditModalVisible(true);
  }, []);

  // Confirm Text Edit or Insert
  const handleConfirmEdit = async (
    newText: string,
    style: TextEditModalConfirmStyle,
  ) => {
    if (!document) return;

    // Case A: Inserting a new added-text layer (multi-line, measured with the same
    // measurer the canvas and exporter use; font family is kept in the model).
    if (modalInsert) {
      try {
        const { document: updatedDoc, element } = createAddedText(
          documentRef.current || document,
          { text: newText, origin: insertLocation, style },
          defaultTextMeasurer,
        );
        commitEdit(updatedDoc);
        setModalInsert(false);
        setEditModalVisible(false);
        setSelectedAddedText(element);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showAlert('Add Text Failed', msg);
      }
      return;
    }

    // Case A2: Editing an existing added-text layer (position is preserved)
    if (isEditingAddedText && selectedAddedText) {
      try {
        const { document: updatedDoc, element } = updateAddedText(
          documentRef.current || document,
          selectedAddedText.id,
          { text: newText, style },
          defaultTextMeasurer,
        );
        commitEdit(updatedDoc);
        setIsEditingAddedText(false);
        setEditModalVisible(false);
        setSelectedAddedText(element);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showAlert('Edit Failed', msg);
      }
      return;
    }

    // Case B: Modifying existing detected region
    if (!selectedRegion) return;

    const page = document.pages[0];
    const imageUri = page.originalContent.assetUri;
    if (!imageUri) return;

    try {
      setReconstructing(true);

      // Reconstruct from the immutable full-resolution working image.
      const patchResult = await defaultReconstructionEngine.reconstructBackground(
        imageUri,
        selectedRegion.bounds,
        { outputDir: sessionPatchDirRef.current },
      );

      const { patchUnavailable: _wasUnavailable, ...regionBase } = selectedRegion;
      const updatedRegion: TextRegion = {
        ...regionBase,
        currentText: newText,
        status: 'modified',
        originalBounds: selectedRegion.originalBounds || selectedRegion.bounds,
        reconstructedPatchUri: patchResult.patchUri,
        reconstructedPatchBounds: patchResult.bounds,
        style: {
          ...selectedRegion.style,
          fontFamily: style.fontFamily ?? selectedRegion.style.fontFamily,
          fontSize: style.fontSize ?? selectedRegion.style.fontSize,
          color: style.color ?? selectedRegion.style.color,
          fontWeight: style.fontWeight ?? selectedRegion.style.fontWeight,
          fontStyle: style.fontStyle ?? selectedRegion.style.fontStyle,
        },
      };

      const base = documentRef.current || document;
      const updatedRegions = base.pages[0].editableTextRegions.map((r) =>
        r.id === selectedRegion.id ? updatedRegion : r,
      );

      const updatedPages = [...base.pages];
      updatedPages[0] = {
        ...updatedPages[0],
        editableTextRegions: updatedRegions,
      };

      const updatedDoc: Document = {
        ...base,
        metadata: { ...base.metadata, updatedAt: Date.now() },
        pages: updatedPages,
      };

      commitEdit(updatedDoc);

      setSelectedRegion(updatedRegion);
      setEditModalVisible(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Edit Failed', `The text could not be changed: ${msg}`);
    } finally {
      setReconstructing(false);
    }
  };

  // Delete selected OCR text region
  const performDeleteRegion = async (target: TextRegion) => {
    const current = documentRef.current;
    if (!current) return;

    const page = current.pages[0];
    const imageUri = page.originalContent.assetUri;
    if (!imageUri) return;

    try {
      setReconstructing(true);

      const patchResult = await defaultReconstructionEngine.reconstructBackground(
        imageUri,
        target.bounds,
        { outputDir: sessionPatchDirRef.current },
      );

      const { patchUnavailable: _wasUnavailable, ...regionBase } = target;
      const updatedRegion: TextRegion = {
        ...regionBase,
        currentText: '',
        status: 'deleted',
        originalBounds: target.originalBounds || target.bounds,
        reconstructedPatchUri: patchResult.patchUri,
        reconstructedPatchBounds: patchResult.bounds,
      };

      const updatedRegions = page.editableTextRegions.map((r) =>
        r.id === target.id ? updatedRegion : r,
      );

      const updatedPages = [...current.pages];
      updatedPages[0] = {
        ...updatedPages[0],
        editableTextRegions: updatedRegions,
      };

      const updatedDoc: Document = {
        ...current,
        metadata: { ...current.metadata, updatedAt: Date.now() },
        pages: updatedPages,
      };

      commitEdit(updatedDoc);
      setSelectedRegion(null);
      showToast('Text removed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Delete Failed', `The text could not be removed: ${msg}`);
    } finally {
      setReconstructing(false);
    }
  };

  const handleDeleteRegion = () => {
    if (!selectedRegion) return;
    const target = selectedRegion;
    if (!appSettings.get().confirmDestructive) {
      performDeleteRegion(target);
      return;
    }
    showAlert('Remove Text?', 'The text is removed and the background behind it is rebuilt.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => performDeleteRegion(target) },
    ]);
  };

  // Delete selected added text element (only that layer; undoable)
  const handleDeleteAddedText = async () => {
    const current = documentRef.current || document;
    if (!current || !selectedAddedText) return;

    commitEdit(deleteAddedText(current, selectedAddedText.id));

    setSelectedAddedText(null);
    setIsEditingAddedText(false);
    setEditModalVisible(false);
  };

  // Completed direct manipulation of an added-text layer from the canvas (one-finger move
  // and/or two-finger resize, document-space values): ONE undoable history step.
  const handleManipulateAddedText = useCallback(
    (id: string, manipulation: { dx: number; dy: number; scale: number }): boolean => {
      const current = documentRef.current;
      const page = current?.pages[0];
      if (!current || !page || !page.addedText?.some((el) => el.id === id)) return false;
      try {
        const { document: nextDoc, element, changed } = manipulateAddedText(
          current,
          id,
          manipulation,
          { minFontSize: MIN_ADDED_TEXT_FONT_SIZE, maxFontSize: maxAddedTextFontSize(page.dimensions) },
          defaultTextMeasurer,
        );
        if (!changed) return false; // clamped to the same geometry: no history step
        commitEdit(nextDoc);
        setSelectedAddedText(element);
        setSelectedRegion(null);
        return true;
      } catch (err: unknown) {
        console.warn('[PHASE14_IMAGE] Added text manipulation failed:', err);
        return false;
      }
    },
    [commitEdit],
  );

  const handleOpenAddedTextEditor = () => {
    if (!selectedAddedText) return;
    setModalInsert(false);
    setIsEditingAddedText(true);
    setEditModalVisible(true);
  };

  const openRegionEditor = useCallback(() => {
    setModalInsert(false);
    setIsEditingAddedText(false);
    setEditModalVisible(true);
  }, []);

  // Canvas selection: one event per tap / drag, resolved by resolveImageCanvasTap (exactly one
  // kind selected; tapping the selected text again opens its Edit panel).
  const handleSelectionHit = useCallback(
    (hit: ImageCanvasHit | null, source: 'tap' | 'drag') => {
      if (mode !== 'view' && mode !== 'insert') return;
      const current = { regionId: selectedRegion?.id ?? null, addedId: selectedAddedText?.id ?? null };
      const { selection, openEditor } = resolveImageCanvasTap(current, hit);
      if (openEditor && source === 'tap') {
        setModalInsert(false);
        setIsEditingAddedText(selection.addedId !== null);
        setEditModalVisible(true);
        return;
      }
      if (hit) {
        haptic('selection');
        setOcrHintVisible(false);
      }
      setSelectedRegion(hit?.kind === 'region' ? hit.region : null);
      setSelectedAddedText(hit?.kind === 'added' ? hit.element : null);
    },
    [mode, selectedRegion, selectedAddedText],
  );

  // Undo action (in-memory; persisted only on Save)
  const handleUndo = async () => {
    if (!history.current.canUndo) return;
    const prevDoc = history.current.undo();
    if (prevDoc) {
      updateHistoryFlags();
      documentRef.current = prevDoc;
      setDocument(prevDoc);
      syncDirtyState(prevDoc);
      setSelectedRegion(null);
      setSelectedAddedText(null);
    }
  };

  // Redo action (in-memory; persisted only on Save)
  const handleRedo = async () => {
    if (!history.current.canRedo) return;
    const nextDoc = history.current.redo();
    if (nextDoc) {
      updateHistoryFlags();
      documentRef.current = nextDoc;
      setDocument(nextDoc);
      syncDirtyState(nextDoc);
      setSelectedRegion(null);
      setSelectedAddedText(null);
    }
  };

  // -------------------------------------------------------------------------
  // Export / share
  // -------------------------------------------------------------------------

  const galleryAvailable =
    Platform.OS === 'ios' || (Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 29);

  const shareExport = async (destinationUri: string, format: ExportFormat) => {
    try {
      await defaultExportEngine.shareExportedFile(destinationUri, format, 'Share Edited Image');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Share Failed', msg || 'Could not open the share sheet.');
    }
  };

  // Confirm Export (exports the current edits; does not change saved/dirty state)
  const handleConfirmExport = async (format: ExportFormat, quality: number, action: ExportAction) => {
    const current = documentRef.current;
    if (!current) return;

    let result: ExportResult | null = null;
    try {
      setIsExporting(true);
      result = await defaultExportEngine.exportDocument(current, {
        format,
        quality,
        destination: action === 'gallery' ? 'gallery' : 'file',
        displayName: current.metadata.title,
      });
      setExportModalVisible(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Export Failed', msg || 'Failed to export image.');
      return;
    } finally {
      setIsExporting(false);
    }

    if (!result) return;
    const exported: ExportResult = result;
    if (action === 'share') {
      await shareExport(exported.destinationUri, exported.format);
      return;
    }

    if (exported.savedToGallery) {
      showToast('Saved to Photos', { tone: 'success' });
    } else {
      showAlert(
        'Export Ready',
        'This device cannot add the image to the photo library directly. Use Share to save or send it.',
        [
          { text: 'Close', style: 'cancel' },
          { text: 'Share', onPress: () => shareExport(exported.destinationUri, exported.format) },
        ],
      );
    }
  };

  const quickShare = async () => {
    const current = documentRef.current;
    if (!current || isExporting) return;
    try {
      setIsExporting(true);
      const result = await defaultExportEngine.exportDocument(current, {
        format: settings.defaultImageExportFormat,
        quality: Math.round(settings.defaultImageExportQuality * 100),
        destination: 'file',
        displayName: current.metadata.title,
      });
      setIsExporting(false);
      await shareExport(result.destinationUri, result.format);
    } catch (err: unknown) {
      setIsExporting(false);
      showAlert('Share Failed', err instanceof Error ? err.message : String(err));
    }
  };

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  const docPerPoint = documentPixelsPerPoint(fitScale);
  const markupWidth = (MARKUP_WIDTHS[markupWidthIndex] ?? 3) * docPerPoint;

  const startMarkup = useCallback(() => {
    setSelectedRegion(null);
    setSelectedAddedText(null);
    setDrawings([]);
    setMode('markup');
  }, []);

  const flushLive = useCallback(() => {
    liveFrameRef.current = null;
    setLivePoints([...livePointsRef.current]);
  }, []);
  const onDrawStart = useCallback((p: Point) => {
    livePointsRef.current = [p];
    setLivePoints([p]);
  }, []);
  const onDrawMove = useCallback(
    (p: Point) => {
      livePointsRef.current.push(p);
      if (liveFrameRef.current === null) liveFrameRef.current = requestAnimationFrame(flushLive);
    },
    [flushLive],
  );
  const onDrawEnd = useCallback(() => {
    const pts = livePointsRef.current;
    livePointsRef.current = [];
    setLivePoints([]);
    const drawing = drawingFromGesture(markupTool, pts, { color: markupColor, width: markupWidth }, 3 * docPerPoint);
    if (drawing) setDrawings((d) => [...d, drawing]);
  }, [markupTool, markupColor, markupWidth, docPerPoint]);

  const finishMarkup = useCallback(() => {
    const current = documentRef.current;
    if (current && drawings.length > 0) {
      commitEdit(addImageDrawings(current, toImageDrawings(drawings)));
      appSettings.update({ markupColor });
      showToast('Markup added', { tone: 'success' });
    }
    exitMode();
  }, [drawings, commitEdit, exitMode, markupColor]);

  const liveDrawing: LiveDrawing | null = useMemo(() => {
    if (mode !== 'markup') return null;
    const highlighter = markupTool === 'highlighter';
    const pending = drawings;
    if (livePoints.length === 0 && pending.length === 0) return null;
    // Pending drawings are drawn through `drawings` below; the live stroke here.
    return livePoints.length > 0
      ? {
          commands: previewCommands(markupTool, livePoints, markupWidth),
          color: markupColor,
          width: highlighter ? markupWidth * HIGHLIGHTER_WIDTH_FACTOR : markupWidth,
          opacity: highlighter ? HIGHLIGHTER_OPACITY : 1,
          multiply: highlighter,
        }
      : null;
  }, [mode, markupTool, livePoints, markupWidth, markupColor, drawings]);

  // -------------------------------------------------------------------------
  // Signature placement (screen space)
  // -------------------------------------------------------------------------

  const imageScreenRect: ScreenRect | null = useMemo(
    () =>
      pageWidth > 0
        ? {
            x: transform.translateX,
            y: transform.translateY,
            width: pageWidth * transform.scale,
            height: pageHeight * transform.scale,
          }
        : null,
    [pageWidth, pageHeight, transform.translateX, transform.translateY, transform.scale],
  );

  const handleChooseSignature = useCallback(
    (sig: SavedSignature) => {
      setSignaturesVisible(false);
      handleFit();
      setPlacingSignature(sig);
      setPlacementRect(null);
      setSelectedRegion(null);
      setSelectedAddedText(null);
      setMode('placeSignature');
    },
    [handleFit],
  );

  // Initial placement box once the fit transform is known
  useEffect(() => {
    if (mode !== 'placeSignature' || !placingSignature || placementRect || !imageScreenRect) return;
    const w = Math.min(imageScreenRect.width * 0.5, 240);
    const h = w * (placingSignature.height / placingSignature.width);
    setPlacementRect({
      x: imageScreenRect.x + (imageScreenRect.width - w) / 2,
      y: imageScreenRect.y + (imageScreenRect.height - h) / 2,
      width: w,
      height: h,
    });
  }, [mode, placingSignature, placementRect, imageScreenRect]);

  const confirmSignature = useCallback(() => {
    const current = documentRef.current;
    if (!current || !placingSignature || !placementRect || transform.scale <= 0) {
      exitMode();
      return;
    }
    const docRect = {
      x: (placementRect.x - transform.translateX) / transform.scale,
      y: (placementRect.y - transform.translateY) / transform.scale,
      width: placementRect.width / transform.scale,
      height: placementRect.height / transform.scale,
    };
    commitEdit(addImageDrawings(current, [signatureDrawing(placingSignature, docRect)]));
    showToast('Signature added', { tone: 'success' });
    exitMode();
  }, [placingSignature, placementRect, transform, commitEdit, exitMode]);

  // -------------------------------------------------------------------------
  // Rotate / flip / crop
  // -------------------------------------------------------------------------

  const runTransform = useCallback(
    async (request: ImageTransformRequest, label: string): Promise<boolean> => {
      const current = documentRef.current;
      const page = current?.pages[0];
      if (!current || !page?.originalContent.assetUri) return false;
      const outDir = sessionPatchDirRef.current;
      if (!outDir) {
        showAlert('Not Available', 'Rotating and cropping need on-device storage, which is unavailable.');
        return false;
      }
      if (pageHasEdits(page)) {
        const ok = await confirmAction(
          'Flatten Edits?',
          'Your text edits and markup will be merged into the image before it is rotated or cropped. You can undo this.',
          'Continue',
        );
        if (!ok) return false;
      }
      setBusyLabel(label);
      try {
        let source = page.originalContent.assetUri;
        if (pageHasEdits(page)) {
          // Bake every layer at full resolution (same compositor as export).
          const baked = await defaultExportEngine.exportDocument(current, { format: 'png', destination: 'file' });
          source = baked.destinationUri;
        }
        const image = await transformImageFile(source, outDir, request);
        commitEdit(applyTransformedImage(current, image));
        setSelectedRegion(null);
        setSelectedAddedText(null);
        haptic('success');
        return true;
      } catch (err: unknown) {
        showAlert('Unable to Transform Image', err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusyLabel(null);
      }
    },
    [commitEdit],
  );

  const startCrop = useCallback(() => {
    setSelectedRegion(null);
    setSelectedAddedText(null);
    setCropAspect(null);
    setCropRect(null);
    handleFit();
    setMode('crop');
  }, [handleFit]);

  useEffect(() => {
    if (mode === 'crop' && !cropRect && imageScreenRect) setCropRect(imageScreenRect);
  }, [mode, cropRect, imageScreenRect]);

  const chooseAspect = (value: number | null) => {
    if (!imageScreenRect) return;
    const aspect = value === -1 ? pageWidth / Math.max(1, pageHeight) : value;
    setCropAspect(aspect);
    setCropRect(aspect ? fitAspectRect(imageScreenRect, aspect) : imageScreenRect);
  };

  const confirmCrop = useCallback(async () => {
    if (!cropRect || transform.scale <= 0) {
      exitMode();
      return;
    }
    const docRect = normalizeCropRect(
      {
        x: (cropRect.x - transform.translateX) / transform.scale,
        y: (cropRect.y - transform.translateY) / transform.scale,
        width: cropRect.width / transform.scale,
        height: cropRect.height / transform.scale,
      },
      pageWidth,
      pageHeight,
    );
    const isFull = docRect.x <= 1 && docRect.y <= 1 && docRect.width >= pageWidth - 2 && docRect.height >= pageHeight - 2;
    if (isFull) {
      exitMode();
      return;
    }
    const ok = await runTransform({ crop: docRect }, 'Cropping…');
    if (ok) {
      showToast('Cropped', { tone: 'success' });
      exitMode();
    }
  }, [cropRect, transform, pageWidth, pageHeight, runTransform, exitMode]);

  const rotateInCrop = async (quarterTurns: number) => {
    const ok = await runTransform({ quarterTurns }, 'Rotating…');
    if (ok) {
      setCropRect(null);
      setCropAspect(null);
    }
  };

  const flipInCrop = async () => {
    const ok = await runTransform({ flipHorizontal: true }, 'Flipping…');
    if (ok) setCropRect(null);
  };

  // -------------------------------------------------------------------------
  // Text copy (Live Text)
  // -------------------------------------------------------------------------

  const copyAllText = async () => {
    const text = collectImageText(documentRef.current?.pages[0]);
    if (!text) {
      showAlert('No Text Yet', 'Use Detect Text first to find the text in this image.');
      return;
    }
    const ok = await copyText(text);
    showToast(ok ? 'All text copied' : 'Copy is not available', { icon: ok ? 'check' : undefined });
  };

  const copyRegionText = async () => {
    if (!selectedRegion) return;
    const ok = await copyText(selectedRegion.status === 'modified' ? selectedRegion.currentText : selectedRegion.originalText);
    showToast(ok ? 'Copied' : 'Copy is not available', { icon: ok ? 'check' : undefined });
  };

  const handleMoreMenu = () => {
    showActionSheet({
      title: document?.metadata.title,
      options: [
        { label: 'Export…', icon: 'download', onPress: () => setExportModalVisible(true) },
        { label: 'Share', icon: 'share', onPress: () => quickShare() },
        { label: 'Sign', icon: 'signature', onPress: () => setSignaturesVisible(true) },
        { label: 'Crop & Rotate', icon: 'crop', onPress: () => startCrop() },
        { label: 'Copy All Text', icon: 'docText', onPress: () => copyAllText() },
        {
          label: 'Share All Text',
          icon: 'text',
          onPress: async () => {
            const text = collectImageText(documentRef.current?.pages[0]);
            if (!text) {
              showAlert('No Text Yet', 'Use Detect Text first to find the text in this image.');
              return;
            }
            await shareText(text, 'Share Text');
          },
        },
      ],
    });
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <View style={[styles.loadingScreen, { backgroundColor: colors.groupedBackground }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Opening image…</Text>
      </View>
    );
  }

  if (errorMessage || !document || document.pages.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: colors.groupedBackground }]}>
        <NavBar title="Image" left={<BackButton label="Library" onPress={() => navigation.goBack()} />} />
        <EmptyState
          style={styles.flex}
          icon="photo"
          title="Unable to Open Image"
          message={errorMessage || 'The document could not be opened.'}
          action={<PillButton label="Back to Library" onPress={() => navigation.goBack()} large style={{ marginTop: spacing.lg }} />}
        />
      </View>
    );
  }

  const page = document.pages[0];
  const imageUri = page.originalContent.assetUri;
  const documentWidth = page.dimensions.width;
  const documentHeight = page.dimensions.height;
  const textRegions = page.editableTextRegions || [];
  const addedText = page.addedText || [];
  const pageDrawings = page.drawings || [];
  const visibleDrawings =
    mode === 'markup' && drawings.length > 0 ? [...pageDrawings, ...toImageDrawings(drawings)] : pageDrawings;
  const busy = scanning || reconstructing || !!busyLabel || isSaving;
  const detectedCount = textRegions.filter((r) => r.status !== 'deleted').length;

  // ---- Top bar
  let topBar: React.ReactNode;
  if (mode === 'markup') {
    topBar = (
      <NavBar
        title="Markup"
        subtitle="Draw with one finger · two fingers to zoom"
        left={<BarButton label="Cancel" onPress={cancelMarkup} />}
        right={<BarButton label="Done" prominent onPress={finishMarkup} />}
      />
    );
  } else if (mode === 'crop') {
    topBar = (
      <NavBar
        title="Crop & Rotate"
        left={<BarButton label="Cancel" onPress={exitMode} disabled={!!busyLabel} />}
        right={<BarButton label="Done" prominent onPress={confirmCrop} loading={!!busyLabel} />}
      />
    );
  } else if (mode === 'placeSignature') {
    topBar = (
      <NavBar
        title="Place Signature"
        subtitle="Drag to move · pinch to resize"
        left={<BarButton label="Cancel" onPress={exitMode} />}
        right={<BarButton label="Done" prominent onPress={confirmSignature} />}
      />
    );
  } else {
    topBar = (
      <NavBar
        title={document.metadata.title}
        subtitle={isDirty ? 'Edited' : `${documentWidth} × ${documentHeight}`}
        left={<BackButton label="Library" compact onPress={handleBack} disabled={busy} />}
        right={
          <>
            <BarButton icon="moreCircle" onPress={handleMoreMenu} accessibilityLabel="More actions" loading={isExporting} disabled={busy} />
            <BarButton
              label="Save"
              prominent
              onPress={() => {
                handleSave();
              }}
              disabled={!isDirty || busy}
              loading={isSaving}
              accessibilityLabel="Save image edits"
            />
          </>
        }
      />
    );
  }

  // ---- Bottom
  const toolbarItems: ToolbarItem[] = [
    { key: 'undo', icon: 'undo', label: 'Undo', onPress: handleUndo, disabled: !canUndo || busy },
    { key: 'redo', icon: 'redo', label: 'Redo', onPress: handleRedo, disabled: !canRedo || busy },
    { key: 'detect', icon: 'scanText', label: detectedCount > 0 ? 'Rescan' : 'Detect Text', onPress: handleRunOcr, loading: scanning, disabled: busy },
    {
      key: 'text',
      icon: 'textAdd',
      label: 'Add Text',
      active: isInsertMode,
      onPress: () => {
        setSelectedRegion(null);
        setSelectedAddedText(null);
        setMode(isInsertMode ? 'view' : 'insert');
      },
      disabled: busy,
    },
    { key: 'markup', icon: 'scribble', label: 'Markup', onPress: startMarkup, disabled: busy },
    { key: 'crop', icon: 'crop', label: 'Crop', onPress: startCrop, disabled: busy },
  ];

  let bottom: React.ReactNode;
  if (mode === 'markup') {
    bottom = (
      <MarkupToolbar
        tool={markupTool}
        color={markupColor}
        widthIndex={markupWidthIndex}
        canUndoStroke={drawings.length > 0}
        onToolChange={(t) => {
          setMarkupTool(t);
          if (t === 'highlighter' && !HIGHLIGHTER_COLORS.includes(markupColor)) setMarkupColor(HIGHLIGHTER_COLORS[0]);
          if (t !== 'highlighter' && HIGHLIGHTER_COLORS.includes(markupColor)) setMarkupColor('#007AFF');
        }}
        onColorChange={setMarkupColor}
        onWidthChange={setMarkupWidthIndex}
        onUndoStroke={() => setDrawings((d) => d.slice(0, -1))}
      />
    );
  } else if (mode === 'crop') {
    bottom = (
      <View style={[styles.cropBar, { backgroundColor: colors.bar, borderTopColor: colors.separator }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.aspectRow}>
          {CROP_ASPECTS.map((a) => {
            const resolved = a.value === -1 ? pageWidth / Math.max(1, pageHeight) : a.value;
            const active = (resolved === null && cropAspect === null) || (resolved !== null && cropAspect !== null && Math.abs(resolved - cropAspect) < 0.001);
            return (
              <Pressable
                key={a.label}
                onPress={() => chooseAspect(a.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.aspectChip, { backgroundColor: active ? colors.primary : colors.fillTertiary }]}>
                <Text style={[styles.aspectText, { color: active ? '#FFFFFF' : colors.textPrimary }]}>{a.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Toolbar
          items={[
            { key: 'rl', icon: 'rotateLeft', label: 'Rotate Left', onPress: () => rotateInCrop(3), disabled: !!busyLabel },
            { key: 'rr', icon: 'rotateRight', label: 'Rotate Right', onPress: () => rotateInCrop(1), disabled: !!busyLabel },
            { key: 'flip', icon: 'flip', label: 'Flip', onPress: flipInCrop, disabled: !!busyLabel },
            { key: 'reset', icon: 'fit', label: 'Reset', onPress: () => { setCropAspect(null); setCropRect(imageScreenRect); }, disabled: !!busyLabel },
          ]}
        />
      </View>
    );
  } else if (mode === 'placeSignature') {
    bottom = <View style={{ height: insets.bottom, backgroundColor: colors.bar }} />;
  } else {
    bottom = <Toolbar items={toolbarItems} />;
  }

  const contextItems: EditMenuItem[] = selectedRegion
    ? [
        { key: 'edit', label: 'Edit', icon: 'pencil', primary: true, onPress: openRegionEditor, accessibilityLabel: 'Edit text' },
        { key: 'copy', label: 'Copy', onPress: copyRegionText, accessibilityLabel: 'Copy text' },
        { key: 'delete', label: 'Delete', onPress: handleDeleteRegion, destructive: true, accessibilityLabel: 'Delete text' },
      ]
    : selectedAddedText
      ? [
          { key: 'edit', label: 'Edit', icon: 'pencil', primary: true, onPress: handleOpenAddedTextEditor, accessibilityLabel: 'Edit text' },
          { key: 'copy', label: 'Copy', onPress: async () => { const ok = await copyText(selectedAddedText.text); showToast(ok ? 'Copied' : 'Copy is not available'); }, accessibilityLabel: 'Copy text' },
          { key: 'delete', label: 'Delete', onPress: handleDeleteAddedText, destructive: true, accessibilityLabel: 'Delete text' },
        ]
      : [];
  const selectionPreview = selectedRegion
    ? selectedRegion.status === 'modified'
      ? selectedRegion.currentText
      : selectedRegion.originalText
    : selectedAddedText?.text;

  return (
    <View style={[styles.container, { backgroundColor: colors.canvasBackground }]}>
      {topBar}

      {/* Canvas Area */}
      <View
        style={styles.canvasArea}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width > 0 && height > 0) {
            setCanvasLayout({ width, height });
          }
        }}>
        <DocumentCanvas
          transform={transform}
          onTransformChange={setTransform}
          documentWidth={documentWidth}
          documentHeight={documentHeight}
          imageUri={imageUri}
          previewUri={page.originalContent.previewUri}
          minScale={zoomBounds.minScale}
          maxScale={zoomBounds.maxScale}
          textRegions={textRegions}
          addedText={addedText}
          drawings={visibleDrawings}
          drawMode={mode === 'markup'}
          liveDrawing={liveDrawing}
          onDrawStart={onDrawStart}
          onDrawMove={onDrawMove}
          onDrawEnd={onDrawEnd}
          hideOverlays={mode === 'markup' || mode === 'crop' || mode === 'placeSignature'}
          selectedRegionId={selectedRegion?.id}
          selectedAddedTextId={selectedAddedText?.id}
          onSelectionHit={handleSelectionHit}
          onManipulateAddedText={mode === 'view' ? handleManipulateAddedText : undefined}
          onTapLocation={handleCanvasTapLocation}
          isInsertMode={isInsertMode}
        />

        {/* Crop overlay (blocks canvas gestures while cropping) */}
        {mode === 'crop' && cropRect && imageScreenRect && (
          <View style={StyleSheet.absoluteFill}>
            <CropOverlay rect={cropRect} bounds={imageScreenRect} aspect={cropAspect} onChange={setCropRect} />
          </View>
        )}

        {/* Signature placement */}
        {mode === 'placeSignature' && placingSignature && placementRect && imageScreenRect && (
          <PlacementBox rect={placementRect} bounds={imageScreenRect} color={colors.primary} onChange={setPlacementRect}>
            <InkLayer
              items={fitStrokesInto(placingSignature.strokes, { x: 0, y: 0, width: placementRect.width, height: placementRect.height }).map((c, i) => ({
                key: `p${i}`,
                commands: c,
                color: '#1C1C1E',
                width: Math.max(1, placingSignature.strokeRatio * placementRect.height),
              }))}
              width={placementRect.width}
              height={placementRect.height}
            />
          </PlacementBox>
        )}

        {/* Insert hint */}
        {isInsertMode && <HintPill text="Tap where the text should go" actionLabel="Cancel" onAction={() => setMode('view')} />}

        {/* After text detection: how to edit the recognised text */}
        {mode === 'view' && ocrHintVisible && !selectedRegion && !selectedAddedText && detectedCount > 0 && (
          <HintPill icon="scanText" text="Tap highlighted text to edit it" actionLabel="OK" onAction={() => setOcrHintVisible(false)} />
        )}

        {/* Zoom pill: tap to fit */}
        {mode === 'view' && !selectedRegion && !selectedAddedText && fitScale !== null && (
          <Pressable
            onPress={handleFit}
            accessibilityRole="button"
            accessibilityLabel="Fit image to screen"
            style={[styles.zoomPill, { backgroundColor: colors.hud }]}>
            <Text style={[styles.zoomText, { color: colors.onHud }]}>
              {Math.round((transform.scale / (fitScale || 1)) * 100)}%
            </Text>
          </Pressable>
        )}

        {/* iOS edit menu for selected text */}
        {contextItems.length > 0 && !editModalVisible && mode === 'view' && (
          <EditMenu
            items={contextItems}
            preview={selectionPreview}
            disabled={reconstructing}
            onClose={() => {
              setSelectedRegion(null);
              setSelectedAddedText(null);
            }}
          />
        )}

        {/* Busy HUD */}
        {(scanning || reconstructing || busyLabel) && (
          <View style={styles.busyOverlay} pointerEvents="auto">
            <View style={[styles.busyCard, { backgroundColor: colors.hud }]}>
              <ActivityIndicator color={colors.onHud} />
              <Text style={[styles.busyText, { color: colors.onHud }]}>
                {scanning ? 'Detecting text…' : reconstructing ? 'Rebuilding background…' : busyLabel}
              </Text>
            </View>
          </View>
        )}
      </View>

      {bottom}

      {/* Text Editing Bottom Sheet / Modal */}
      <TextEditModal
        visible={editModalVisible}
        initialText={modalInsert ? '' : selectedRegion?.currentText || selectedRegion?.originalText || ''}
        initialStyle={selectedRegion?.style}
        region={isEditingAddedText || modalInsert ? null : selectedRegion}
        addedText={isEditingAddedText ? selectedAddedText : null}
        isProcessing={reconstructing}
        isInsertMode={modalInsert}
        fontScale={documentPixelsPerPoint(fitScale)}
        onConfirm={handleConfirmEdit}
        onDelete={
          isEditingAddedText
            ? handleDeleteAddedText
            : selectedRegion && !modalInsert
              ? () => {
                  setEditModalVisible(false);
                  handleDeleteRegion();
                }
              : undefined
        }
        onCancel={() => {
          setEditModalVisible(false);
          setModalInsert(false);
          setIsEditingAddedText(false);
        }}
      />

      {/* Export Modal */}
      <ExportModal
        visible={exportModalVisible}
        documentWidth={documentWidth}
        documentHeight={documentHeight}
        isExporting={isExporting}
        galleryAvailable={galleryAvailable}
        onExport={handleConfirmExport}
        onCancel={() => setExportModalVisible(false)}
      />

      <SignatureSheet visible={signaturesVisible} onClose={() => setSignaturesVisible(false)} onChoose={handleChooseSignature} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: { flex: 1 },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    ...typography.caption,
  },
  canvasArea: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  zoomPill: { position: 'absolute', bottom: spacing.md, alignSelf: 'center', paddingHorizontal: 11, paddingVertical: 5, borderRadius: 13, minHeight: 26, justifyContent: 'center' },
  zoomText: { ...typography.caption, fontWeight: fontWeights.semibold },
  busyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  busyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg + 2, paddingVertical: spacing.md - 1, borderRadius: 14 },
  busyText: { ...typography.subhead, fontWeight: fontWeights.medium },
  cropBar: { borderTopWidth: StyleSheet.hairlineWidth },
  aspectRow: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  aspectChip: { paddingHorizontal: 13, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  aspectText: { ...typography.footnote, fontWeight: fontWeights.medium },
});
