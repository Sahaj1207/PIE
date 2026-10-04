import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Dimensions,
  BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { PdfEditorScreenRouteProp } from '../navigation/types';
import { defaultPdfiumEngine } from '../features/pdf/pdfiumEngine';
import { PdfDocumentEditor, resolveStandardFontName } from '../features/pdf/pdfDocumentEditor';
import {
  PdfRenderedPage,
  PdfTextObject,
  PdfTextFormatOptions,
  PdfTextEditCommand,
  PdfReplaceCommand,
  PdfInsertCommand,
  PdfSelectionState,
  createPdfSelectionState,
} from '../features/pdf/types';
import {
  PdfFontLimitationError,
  PdfInvalidObjectPathError,
  PdfUnsupportedReplacementError,
  PdfInvalidReplacementError,
  PdfTextDeletionError,
  PdfNonDeletableObjectError,
  PdfTextInsertionError,
  PdfInvalidPlacementError,
} from '../errors';
import { PdfViewport } from '../features/pdf/components/PdfViewport';
import { PdfTextEditModal } from '../features/pdf/components/PdfTextEditModal';
import { colors, radius, spacing, typography } from '../constants/theme';
import { documentStorage } from '../storage';
import { Document } from '../types/document';

interface PageCacheEntry {
  renderedPage: PdfRenderedPage;
  textObjects: PdfTextObject[];
  originalObjects: PdfTextObject[];
}

export const PdfEditorScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  const route = useRoute<PdfEditorScreenRouteProp>();
  const navigation = useNavigation();
  const theme = colors.light;

  // Document & Page state
  const [currentPdfPath, setCurrentPdfPath] = useState<string>('');
  const [documentTitle, setDocumentTitle] = useState<string>('Document.pdf');
  const [pageCount, setPageCount] = useState<number>(1);
  const [currentPageIndex, setCurrentPageIndex] = useState<number>(0);
  const [renderedPage, setRenderedPage] = useState<PdfRenderedPage | null>(null);
  const [textObjects, setTextObjects] = useState<PdfTextObject[]>([]);
  const [originalObjects, setOriginalObjects] = useState<PdfTextObject[]>([]);
  const [selectedObject, setSelectedObject] = useState<PdfTextObject | null>(null);
  const [pdfSelection, setPdfSelection] = useState<PdfSelectionState | null>(null);

  const handleSelectObject = useCallback(
    (obj: PdfTextObject | null) => {
      setSelectedObject(obj);
      if (obj) {
        setPdfSelection(createPdfSelectionState(obj, currentPageIndex));
      } else {
        setPdfSelection(null);
      }
    },
    [currentPageIndex],
  );

  // Dynamic viewport area measurement
  const [viewportLayout, setViewportLayout] = useState<{ width: number; height: number } | null>(null);

  // Page render cache to avoid repeated PDFium rendering when paging back and forth
  const pageCacheRef = useRef<Map<number, PageCacheEntry>>(new Map());

  // Editor engine ref (holds in-memory pending edits & undo/redo)
  const editorRef = useRef<PdfDocumentEditor | null>(null);

  // Modal & Text Insertion state
  const [editModalVisible, setEditModalVisible] = useState<boolean>(false);
  const [isInsertMode, setIsInsertMode] = useState<boolean>(false);
  const [isPlacementMode, setIsPlacementMode] = useState<boolean>(false);
  const [insertLocation, setInsertLocation] = useState<{ x: number; y: number }>({ x: 54, y: 120 });

  // Undo / Redo & Pending changes counter
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isDirtyState, setIsDirtyState] = useState<boolean>(false);
  const [pendingEdits, setPendingEdits] = useState<readonly PdfTextEditCommand[]>([]);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);

  // UI status / async loading states
  const [loading, setLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Lazy initialize editor instance
  const getEditor = useCallback((): PdfDocumentEditor => {
    if (!editorRef.current) {
      editorRef.current = new PdfDocumentEditor(defaultPdfiumEngine);
    }
    return editorRef.current;
  }, []);

  const updateHistoryState = useCallback((editor: PdfDocumentEditor) => {
    const edits = editor.getPendingEdits();
    setPendingEdits([...edits]);
    setPendingCount(edits.length);
    setCanUndo(editor.canUndo());
    setCanRedo(editor.canRedo());
    setIsDirtyState(editor.isDirty ? editor.isDirty() : edits.length > 0);
  }, []);

  // Render page raster and fetch visible vector text objects (with cache)
  const loadPage = useCallback(
    async (pageIdx: number, forceBypassCache = false) => {
      try {
        setErrorMessage(null);
        setSelectedObject(null);
        setPdfSelection(null);
        setIsPlacementMode(false);

        // Check page cache first for instant, zero-stutter page switching
        if (!forceBypassCache && pageCacheRef.current.has(pageIdx)) {
          const cached = pageCacheRef.current.get(pageIdx)!;
          setRenderedPage(cached.renderedPage);
          setTextObjects(cached.textObjects);
          setOriginalObjects(cached.originalObjects);
          setCurrentPageIndex(pageIdx);
          setLoading(false);
          return;
        }

        setLoading(true);
        const editor = getEditor();
        const pageSize = await editor.getPageSize(pageIdx);

        // Render page raster at high DPI (scale 2.0)
        const rendered = await defaultPdfiumEngine.renderPage(
          (editor as any).docHandle?.docHandle ?? 0,
          pageIdx,
          { scale: 2.0 },
        );
        console.log('[PHASE1_PDF] PAGE_RENDER_SUCCESS: page ' + (pageIdx + 1) + ' of ' + editor.getPageCount() + ' (' + pageSize.width + 'x' + pageSize.height + ' pt)');

        const objects = await editor.getTextObjects(pageIdx);
        // Snapshot unedited original objects for knockout patches
        const origRaw = await defaultPdfiumEngine.getTextObjects(
          (editor as any).docHandle?.docHandle ?? 0,
          pageIdx,
        );

        const newRenderedPage: PdfRenderedPage = {
          ...rendered,
          pageWidth: pageSize.width,
          pageHeight: pageSize.height,
        };

        // Cache this page
        pageCacheRef.current.set(pageIdx, {
          renderedPage: newRenderedPage,
          textObjects: objects,
          originalObjects: origRaw,
        });

        setRenderedPage(newRenderedPage);
        setTextObjects(objects);
        setOriginalObjects(origRaw);
        setCurrentPageIndex(pageIdx);
        updateHistoryState(editor);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(`Failed to load page ${pageIdx + 1}: ${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [getEditor, updateHistoryState],
  );

  // Initial document open
  const openPdfDocument = useCallback(
    async (targetPath?: string, title?: string) => {
      const path = targetPath || route.params?.pdfPath;
      if (!path) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setErrorMessage(null);
        pageCacheRef.current.clear();
        setSelectedObject(null);
        setPdfSelection(null);

        const cleanTitle = title || route.params?.fileName || path.split(/[\\/]/).pop() || 'Document.pdf';
        setCurrentPdfPath(path);
        setDocumentTitle(cleanTitle);

        const editor = getEditor();
        await editor.open(path);
        console.log('[PHASE1_PDF] OPEN_SUCCESS: ' + path);

        const count = editor.getPageCount();
        setPageCount(count);
        console.log('[PHASE1_PDF] PAGE_COUNT: ' + count);

        await loadPage(0, true);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(`Failed to open PDF document: ${msg}`);
        setLoading(false);
      }
    },
    [route.params?.pdfPath, route.params?.fileName, getEditor, loadPage],
  );

  useEffect(() => {
    openPdfDocument();

    return () => {
      pageCacheRef.current.clear();
      if (editorRef.current) {
        editorRef.current.close().catch(() => {});
      }
    };
  }, [openPdfDocument]);

  // Start "+ Text" placement mode
  const handleStartPlacement = useCallback(() => {
    setSelectedObject(null);
    setPdfSelection(null);
    setIsPlacementMode(true);
  }, []);

  // When user taps location on page in placement mode
  const handlePlaceTextAt = useCallback((point: { x: number; y: number }) => {
    setIsPlacementMode(false);
    setInsertLocation(point);
    setIsInsertMode(true);
    setEditModalVisible(true);
  }, []);

  // Open Edit Modal for selected text
  const handleOpenEdit = useCallback(() => {
    if (!selectedObject) return;
    setIsInsertMode(false);
    setEditModalVisible(true);
  }, [selectedObject]);

  // Apply Edit or Insert
  const handleApplyModalText = useCallback(
    async (text: string, format: PdfTextFormatOptions) => {
      const editor = getEditor();
      setEditModalVisible(false);

      if (isInsertMode) {
        const trimmed = text.trim();
        if (!trimmed) {
          Alert.alert('Invalid Text', 'Text cannot be empty or whitespace only.');
          return;
        }

        // 1. Live/optimistic preview before native persistence
        const fontSize = format?.fontSize ?? 14;
        const previewCmd: PdfInsertCommand = {
          type: 'insert',
          objectId: `p${currentPageIndex}_ins_preview_${Date.now()}`,
          pageIndex: currentPageIndex,
          text: trimmed,
          x: insertLocation.x,
          y: insertLocation.y,
          bounds: {
            x: insertLocation.x,
            y: insertLocation.y,
            width: Math.max(trimmed.length * fontSize * 0.54, 24),
            height: fontSize * 1.25,
          },
          fontSize,
          fontName: resolveStandardFontName(format),
          color: format?.color ?? '#000000',
        };
        setPendingEdits([previewCmd]);
        setStatusMessage('Inserting new text natively...');

        // 2. Prepare internal working copy path to guarantee source immutability
        const currentPath = currentPdfPath;
        const lastSlash = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
        const dir = lastSlash >= 0 ? currentPath.substring(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? currentPath.substring(lastSlash + 1) : currentPath;
        const baseName = fileName.replace(/\.pdf$/i, '');
        const workingCopyPath = `${dir}/${baseName}_working_${Date.now()}.pdf`;

        try {
          if (editor.applyNewTextInsertion) {
            const { result, insertedObject } = await editor.applyNewTextInsertion(
              currentPageIndex,
              trimmed,
              insertLocation,
              workingCopyPath,
              format,
            );

            // 3. Native confirmation received: clear preview and update active document
            setPendingEdits([]);
            setCurrentPdfPath(workingCopyPath);
            pageCacheRef.current.clear();

            // Re-render page from working copy
            await loadPage(currentPageIndex, true);

            // Select newly inserted vector text object
            setSelectedObject(insertedObject);
            setPdfSelection(createPdfSelectionState(insertedObject, currentPageIndex));
            setStatusMessage('Text added successfully');
            updateHistoryState(editor);
          } else {
            const newObj = editor.insertText(currentPageIndex, trimmed, insertLocation, format);
            setSelectedObject(newObj);
            pageCacheRef.current.delete(currentPageIndex);
            const updatedObjs = await editor.getTextObjects(currentPageIndex);
            setTextObjects(updatedObjs);
            updateHistoryState(editor);
            setPendingEdits([]);
          }
        } catch (err: unknown) {
          // 4. Failure: remove preview, keep source document untouched, show typed error
          setPendingEdits([]);
          setStatusMessage(null);

          let errorMsg = err instanceof Error ? err.message : String(err);
          if (err instanceof PdfInvalidPlacementError) {
            Alert.alert('Invalid Placement', errorMsg);
          } else if (err instanceof PdfTextInsertionError) {
            Alert.alert('Insertion Failed', errorMsg);
          } else if (err instanceof PdfFontLimitationError) {
            Alert.alert('Font Error', errorMsg);
          } else {
            Alert.alert('Add Text Error', errorMsg);
          }
        }
        return;
      }

      if (selectedObject) {
        const trimmed = text.trim();
        if (!trimmed) {
          Alert.alert('Invalid Text', 'Replacement text cannot be empty or whitespace only.');
          return;
        }

        // 1. Optimistic deterministic UI preview before native persistence
        const previewCmd: PdfReplaceCommand = {
          type: 'replace',
          objectId: selectedObject.id,
          pageIndex: selectedObject.pageIndex,
          objectIndex: selectedObject.objectIndex,
          objectPath: selectedObject.objectPath,
          originalText: selectedObject.text,
          newText: trimmed,
          format,
        };
        setPendingEdits([previewCmd]);
        setStatusMessage('Replacing text natively...');

        // 2. Prepare internal working copy path to guarantee source PDF immutability
        const currentPath = currentPdfPath;
        const lastSlash = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
        const dir = lastSlash >= 0 ? currentPath.substring(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? currentPath.substring(lastSlash + 1) : currentPath;
        const baseName = fileName.replace(/\.pdf$/i, '');
        const workingCopyPath = `${dir}/${baseName}_working_${Date.now()}.pdf`;

        try {
          // 3. Native PDFium replacement via domain editor
          if (editor.applyExistingTextReplacement) {
            const { result, reconciledObject } = await editor.applyExistingTextReplacement(
              selectedObject.id,
              trimmed,
              workingCopyPath,
              format,
            );

            // 4. Native confirmation received: reconcile extracted text and document state
            setPendingEdits([]);
            setCurrentPdfPath(workingCopyPath);
            pageCacheRef.current.clear();

            // Re-render page from working copy
            await loadPage(currentPageIndex, true);

            // Reconcile selection state
            setSelectedObject(reconciledObject);
            setPdfSelection(createPdfSelectionState(reconciledObject, currentPageIndex));
            setStatusMessage('Text replaced successfully');
            updateHistoryState(editor);
          } else {
            editor.replaceText(selectedObject.id, trimmed, format);
            pageCacheRef.current.delete(currentPageIndex);
            const updatedObjs = await editor.getTextObjects(currentPageIndex);
            setTextObjects(updatedObjs);
            updateHistoryState(editor);
            setPendingEdits([]);
          }
        } catch (err: unknown) {
          // 5. Failure preserves original object, removes preview, shows typed error
          setPendingEdits([]);
          setStatusMessage(null);

          let errorMsg = err instanceof Error ? err.message : String(err);
          if (err instanceof PdfFontLimitationError) {
            Alert.alert('Font Limitation', errorMsg);
          } else if (err instanceof PdfInvalidObjectPathError) {
            Alert.alert('Invalid Object Path', errorMsg);
          } else if (err instanceof PdfUnsupportedReplacementError) {
            Alert.alert('Unsupported Replacement', errorMsg);
          } else if (err instanceof PdfInvalidReplacementError) {
            Alert.alert('Invalid Text', errorMsg);
          } else {
            Alert.alert('Replacement Failed', errorMsg);
          }
        }
      }
    },
    [
      getEditor,
      isInsertMode,
      insertLocation,
      selectedObject,
      currentPageIndex,
      currentPdfPath,
      loadPage,
      updateHistoryState,
    ],
  );

  // Delete selected text
  const handleDeleteSelected = useCallback(async () => {
    if (!selectedObject) return;
    const target = selectedObject;
    const editor = getEditor();

    Alert.alert(
      'Delete Text',
      `Are you sure you want to delete "${target.text}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // Prepare internal working copy path to guarantee source PDF immutability
            const currentPath = currentPdfPath;
            const lastSlash = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
            const dir = lastSlash >= 0 ? currentPath.substring(0, lastSlash) : '';
            const fileName = lastSlash >= 0 ? currentPath.substring(lastSlash + 1) : currentPath;
            const baseName = fileName.replace(/\.pdf$/i, '');
            const workingCopyPath = `${dir}/${baseName}_working_${Date.now()}.pdf`;

            setStatusMessage('Deleting text natively...');

            try {
              if (editor.applyExistingTextDeletion) {
                const { result } = await editor.applyExistingTextDeletion(
                  target.id,
                  workingCopyPath,
                );

                // 1. Switch active session to working copy
                setCurrentPdfPath(workingCopyPath);
                pageCacheRef.current.clear();

                // 2. Clear selection state
                setSelectedObject(null);
                setPdfSelection(null);

                // 3. Re-render affected page from working copy
                await loadPage(currentPageIndex, true);

                // 4. Update status and history
                setStatusMessage('Text deleted successfully');
                updateHistoryState(editor);
              } else {
                editor.deleteText(target.id);
                setSelectedObject(null);
                setPdfSelection(null);
                pageCacheRef.current.delete(currentPageIndex);
                const updatedObjs = await editor.getTextObjects(currentPageIndex);
                setTextObjects(updatedObjs);
                updateHistoryState(editor);
              }
            } catch (err: unknown) {
              setStatusMessage(null);
              // Target remains selected on failure
              setSelectedObject(target);
              setPdfSelection(createPdfSelectionState(target, currentPageIndex));

              let errorMsg = err instanceof Error ? err.message : String(err);
              if (err instanceof PdfInvalidObjectPathError) {
                Alert.alert('Object Path Error', errorMsg);
              } else if (err instanceof PdfNonDeletableObjectError) {
                Alert.alert('Non-Deletable Object', errorMsg);
              } else if (err instanceof PdfTextDeletionError) {
                Alert.alert('Deletion Failed', errorMsg);
              } else {
                Alert.alert('Delete Error', errorMsg);
              }
            }
          },
        },
      ],
    );
  }, [
    selectedObject,
    getEditor,
    currentPdfPath,
    currentPageIndex,
    loadPage,
    updateHistoryState,
  ]);

  // Undo action
  const handleUndo = useCallback(async () => {
    const editor = getEditor();
    if (!editor.canUndo() || isSaving) return;

    try {
      editor.undo();
      pageCacheRef.current.delete(currentPageIndex);
      const updatedObjs = await editor.getTextObjects(currentPageIndex);
      setTextObjects(updatedObjs);
      setSelectedObject(null);
      updateHistoryState(editor);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Undo Error', msg);
    }
  }, [getEditor, isSaving, currentPageIndex, updateHistoryState]);

  // Redo action
  const handleRedo = useCallback(async () => {
    const editor = getEditor();
    if (!editor.canRedo() || isSaving) return;

    try {
      editor.redo();
      pageCacheRef.current.delete(currentPageIndex);
      const updatedObjs = await editor.getTextObjects(currentPageIndex);
      setTextObjects(updatedObjs);
      setSelectedObject(null);
      updateHistoryState(editor);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Redo Error', msg);
    }
  }, [getEditor, isSaving, currentPageIndex, updateHistoryState]);

  // Save / Export edited PDF
  const handleSave = useCallback(async (): Promise<boolean> => {
    const editor = getEditor();
    const isDocDirty = editor.isDirty ? editor.isDirty() : pendingCount > 0;
    if (isSaving || !isDocDirty) return false;

    try {
      setIsSaving(true);
      setStatusMessage('Saving document changes...');

      const outputPath = currentPdfPath.replace(/(_(working|edited)(_\d+)?)?\.pdf$/i, '') + '_edited.pdf';

      // 1. Commit all vector operations to PDF with native verification
      await editor.saveDocument(outputPath);

      // Register saved PDF into documentStorage so it appears under DOCUMENTS in HomeScreen
      const docId = `pdf-${Date.now()}`;
      const now = Date.now();
      const savedDoc: Document = {
        id: docId,
        metadata: {
          id: docId,
          title: documentTitle || outputPath.split(/[\\/]/).pop() || 'Document.pdf',
          kind: 'pdf',
          sourceUri: outputPath,
          pageCount: pageCount,
          createdAt: now,
          updatedAt: now,
        },
        pages: [],
      };
      await documentStorage.saveDocument(savedDoc).catch(() => {});

      // 2. Clear entire cache and selection
      pageCacheRef.current.clear();
      setCurrentPdfPath(outputPath);
      setSelectedObject(null);
      setPdfSelection(null);

      // 3. Re-render page and re-extract real persisted text objects
      await loadPage(currentPageIndex, true);
      updateHistoryState(editor);

      setStatusMessage('Changes saved.');
      setTimeout(() => setStatusMessage(null), 4000);

      Alert.alert(
        'Save Complete',
        'Your PDF changes have been saved.',
        [{ text: 'OK' }],
      );
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Save failed: ${msg}`);
      Alert.alert('Save Error', `Failed to save PDF: ${msg}`);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, pendingCount, isDirtyState, getEditor, currentPdfPath, loadPage, currentPageIndex, updateHistoryState]);

  // Back confirmation
  const handleBack = useCallback(() => {
    if (isSaving) return;
    const editor = getEditor();
    const isDocDirty = editor.isDirty ? editor.isDirty() : pendingCount > 0;
    if (isDocDirty) {
      Alert.alert(
        'Unsaved Changes',
        'You have unsaved changes in this document. What would you like to do?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: async () => {
              if (typeof editor.discardWorkingChanges === 'function') {
                await editor.discardWorkingChanges().catch(() => {});
              }
              navigation.goBack();
            },
          },
          {
            text: 'Save',
            onPress: async () => {
              const saved = await handleSave();
              if (saved) {
                navigation.goBack();
              }
            },
          },
        ],
      );
    } else {
      navigation.goBack();
    }
  }, [isSaving, pendingCount, isDirtyState, getEditor, handleSave, navigation]);

  // Hook up Android hardware back button
  useEffect(() => {
    const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBack();
      return true;
    });
    return () => backSub.remove();
  }, [handleBack]);

  // React Navigation beforeRemove guard
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      const editor = getEditor();
      const isDocDirty = editor.isDirty ? editor.isDirty() : pendingCount > 0;
      if (!isDocDirty || isSaving) {
        return;
      }
      e.preventDefault();

      Alert.alert(
        'Unsaved Changes',
        'You have unsaved changes in this document. What would you like to do?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: async () => {
              if (typeof editor.discardWorkingChanges === 'function') {
                await editor.discardWorkingChanges().catch(() => {});
              }
              navigation.dispatch(e.data.action);
            },
          },
          {
            text: 'Save',
            onPress: async () => {
              const saved = await handleSave();
              if (saved) {
                navigation.dispatch(e.data.action);
              }
            },
          },
        ],
      );
    });
    return unsubscribe;
  }, [navigation, getEditor, pendingCount, isSaving, handleSave]);

  // Prompt user to pick a PDF document if opened without one
  const handlePickDocument = useCallback(async () => {
    try {
      if (typeof defaultPdfiumEngine.pickPdfDocument !== 'function') {
        Alert.alert('PDF Picker', 'PDF document picker is not available on this platform.');
        return;
      }
      const picked = await defaultPdfiumEngine.pickPdfDocument();
      if (!picked) return;
      await openPdfDocument(picked.filePath, picked.fileName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Unable to Open PDF', msg);
    }
  }, [openPdfDocument]);

  // Clean empty state if no PDF is loaded
  if (!currentPdfPath && !loading) {
    return (
      <View
        style={[
          styles.container,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            backgroundColor: theme.background,
          },
        ]}>
        <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityLabel="Return to Home">
            <Text style={[styles.backBtnText, { color: theme.primary }]}>‹ Done</Text>
          </TouchableOpacity>
          <Text style={[styles.docTitle, { color: theme.textPrimary }]}>PDF Editor</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={styles.emptyPromptContainer}>
          <Text style={[styles.emptyPromptTitle, { color: theme.textPrimary }]}>No PDF Selected</Text>
          <Text style={[styles.emptyPromptSubtitle, { color: theme.textSecondary }]}>
            Select a PDF document from your device to begin editing text.
          </Text>
          <TouchableOpacity
            style={[styles.primaryActionBtn, { backgroundColor: theme.primary }]}
            onPress={handlePickDocument}>
            <Text style={styles.primaryActionBtnText}>Choose PDF</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Error Screen
  if (errorMessage && !renderedPage && !loading) {
    return (
      <View
        style={[
          styles.container,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            backgroundColor: theme.background,
          },
        ]}>
        <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityLabel="Return to Home">
            <Text style={[styles.backBtnText, { color: theme.primary }]}>‹ Done</Text>
          </TouchableOpacity>
          <Text style={[styles.docTitle, { color: theme.textPrimary }]}>PDF Editor</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={styles.emptyPromptContainer}>
          <Text style={[styles.emptyPromptTitle, { color: theme.textPrimary }]}>Unable to Open PDF</Text>
          <Text style={[styles.emptyPromptSubtitle, { color: theme.textSecondary }]}>{errorMessage}</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.primaryActionBtn, { backgroundColor: theme.primary }]}
              onPress={handlePickDocument}>
              <Text style={styles.primaryActionBtnText}>Choose Different PDF</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          backgroundColor: theme.background,
        },
      ]}>
      {/* Top Header Bar - iOS Style */}
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={handleBack}
          disabled={isSaving}
          accessibilityLabel="Return to Home"
          accessibilityRole="button">
          <Text style={[styles.backBtnText, { color: theme.primary }, isSaving && styles.btnDisabled]}>‹ Done</Text>
        </TouchableOpacity>

        <View style={styles.titleContainer}>
          <Text style={[styles.docTitle, { color: theme.textPrimary }]} numberOfLines={1}>
            {documentTitle}
          </Text>
          {(isDirtyState || pendingCount > 0) && (
            <View style={[styles.pendingBadge, { backgroundColor: theme.primarySubtle }]}>
              <Text style={[styles.pendingBadgeText, { color: theme.primary }]}>
                {pendingCount} unsaved
              </Text>
            </View>
          )}
        </View>

        <View style={styles.headerActions}>
          <TouchableOpacity
            style={[styles.historyBtn, (!canUndo || isSaving) && styles.btnDisabled]}
            disabled={!canUndo || isSaving}
            onPress={handleUndo}
            accessibilityLabel="Undo">
            <Text style={[styles.historyBtnText, { color: theme.textPrimary }]}>↶</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.historyBtn, (!canRedo || isSaving) && styles.btnDisabled]}
            disabled={!canRedo || isSaving}
            onPress={handleRedo}
            accessibilityLabel="Redo">
            <Text style={[styles.historyBtnText, { color: theme.textPrimary }]}>↷</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.saveBtn,
              { backgroundColor: theme.primary },
              (!isDirtyState && pendingCount === 0 || isSaving) && styles.saveBtnDisabled,
            ]}
            onPress={handleSave}
            disabled={(!isDirtyState && pendingCount === 0) || isSaving}
            accessibilityLabel="Save PDF changes">
            {isSaving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.saveBtnText}>Save</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Placement Mode Active Banner */}
      {isPlacementMode && (
        <View style={styles.placementBanner}>
          <Text style={styles.placementBannerText}>Tap anywhere on the page to place text</Text>
          <TouchableOpacity
            onPress={() => setIsPlacementMode(false)}
            style={styles.placementCancelBtn}>
            <Text style={styles.placementCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Status Banner */}
      {statusMessage && (
        <View style={[styles.statusBanner, { backgroundColor: '#F0FDF4' }]}>
          <Text style={[styles.statusText, { color: theme.success }]}>{statusMessage}</Text>
        </View>
      )}

      {/* Main Viewport Container */}
      <View
        style={styles.viewportArea}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width > 0 && height > 0) {
            setViewportLayout({ width, height });
          }
        }}>
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading page...</Text>
          </View>
        ) : (
          <PdfViewport
            page={renderedPage}
            textObjects={textObjects}
            originalTextObjects={originalObjects}
            pendingEdits={pendingEdits}
            selectedObjectId={selectedObject?.id ?? null}
            selectionState={pdfSelection}
            onSelectObject={handleSelectObject}
            isPlacementMode={isPlacementMode}
            onPlaceTextAt={handlePlaceTextAt}
            viewportWidth={viewportLayout?.width}
            viewportHeight={viewportLayout?.height}
          />
        )}

        {/* Floating Context Toolbar when Text is Selected */}
        {selectedObject && !editModalVisible && (
          <View style={[styles.floatingContextBar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.contextObjectText, { color: theme.textPrimary }]} numberOfLines={1}>
              "{selectedObject.text}"
            </Text>
            <View style={styles.contextBtnRow}>
              <TouchableOpacity
                style={[styles.contextBtn, { backgroundColor: theme.primarySubtle }]}
                onPress={handleOpenEdit}>
                <Text style={[styles.contextBtnText, { color: theme.primary }]}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.contextBtn, { backgroundColor: '#FEE2E2' }]}
                onPress={handleDeleteSelected}>
                <Text style={[styles.contextBtnText, { color: theme.danger }]}>Delete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.contextCloseBtn}
                onPress={() => setSelectedObject(null)}>
                <Text style={[styles.contextCloseText, { color: theme.textMuted }]}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* Bottom Toolbar & Page Navigation */}
      <View style={[styles.bottomBar, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
        {/* + Text Button */}
        <TouchableOpacity
          style={[styles.addTextBtn, { backgroundColor: theme.primarySubtle }]}
          onPress={handleStartPlacement}
          disabled={isSaving || loading || isPlacementMode}
          accessibilityLabel="Add Text to PDF">
          <Text style={[styles.addTextBtnText, { color: theme.primary }]}>+ Text</Text>
        </TouchableOpacity>

        {/* Multipage Navigation */}
        {pageCount > 1 ? (
          <View style={styles.pageNavGroup}>
            <TouchableOpacity
              style={[styles.navBtn, (currentPageIndex === 0 || isSaving || loading) && styles.btnDisabled]}
              disabled={currentPageIndex === 0 || isSaving || loading}
              onPress={() => loadPage(currentPageIndex - 1)}>
              <Text style={[styles.navBtnText, { color: theme.primary }]}>‹</Text>
            </TouchableOpacity>

            <Text style={[styles.pageNumberText, { color: theme.textSecondary }]}>
              {currentPageIndex + 1} of {pageCount}
            </Text>

            <TouchableOpacity
              style={[
                styles.navBtn,
                (currentPageIndex >= pageCount - 1 || isSaving || loading) && styles.btnDisabled,
              ]}
              disabled={currentPageIndex >= pageCount - 1 || isSaving || loading}
              onPress={() => loadPage(currentPageIndex + 1)}>
              <Text style={[styles.navBtnText, { color: theme.primary }]}>›</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={[styles.pageNumberText, { color: theme.textMuted }]}>Page 1 of 1</Text>
        )}
      </View>

      {/* Text Editing & Formatting Modal */}
      <PdfTextEditModal
        visible={editModalVisible}
        targetObject={selectedObject}
        isInsertMode={isInsertMode}
        onApply={handleApplyModalText}
        onCancel={() => {
          setEditModalVisible(false);
          setIsInsertMode(false);
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  backBtnText: {
    fontSize: 16,
    fontWeight: '500',
  },
  btnDisabled: {
    opacity: 0.35,
  },
  titleContainer: {
    flex: 1,
    alignItems: 'center',
    marginHorizontal: spacing.sm,
  },
  docTitle: {
    ...typography.bodyMedium,
    fontWeight: '600',
  },
  pendingBadge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: radius.sm,
    marginTop: 1,
  },
  pendingBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  historyBtn: {
    padding: spacing.xs,
    width: 32,
    alignItems: 'center',
  },
  historyBtnText: {
    fontSize: 18,
    fontWeight: '600',
  },
  saveBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    minWidth: 54,
    alignItems: 'center',
    marginLeft: 2,
  },
  saveBtnDisabled: {
    opacity: 0.35,
  },
  saveBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  placementBanner: {
    backgroundColor: '#007AFF',
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  placementBannerText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  placementCancelBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  placementCancelText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  statusBanner: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  viewportArea: {
    flex: 1,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    ...typography.caption,
  },
  emptyPromptContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.md,
  },
  emptyPromptTitle: {
    ...typography.titleMedium,
  },
  emptyPromptSubtitle: {
    ...typography.bodyMedium,
    textAlign: 'center',
    maxWidth: 260,
  },
  primaryActionBtn: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  primaryActionBtnText: {
    color: '#FFFFFF',
    ...typography.titleSmall,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
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
  contextObjectText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    marginRight: spacing.md,
  },
  contextBtnRow: {
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
  contextCloseBtn: {
    padding: spacing.xs,
    marginLeft: 2,
  },
  contextCloseText: {
    fontSize: 14,
    fontWeight: '500',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  addTextBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.md,
  },
  addTextBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  pageNavGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBtnText: {
    fontSize: 18,
    fontWeight: '600',
  },
  pageNumberText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
