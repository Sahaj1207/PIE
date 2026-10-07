import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  BackHandler,
  PixelRatio,
  Pressable,
  Image,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { PdfEditorScreenRouteProp } from '../navigation/types';
import { defaultPdfiumEngine } from '../features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../features/pdf/pdfDocumentEditor';
import {
  PdfRenderedPage,
  PdfRenderedRegion,
  PdfTextObject,
  PdfTextFormatOptions,
  PdfTextEditCommand,
  PdfReplaceCommand,
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
  PdfInvalidPlacementError,
} from '../errors';
import {
  PdfViewport,
  PdfInteractionMode,
  PdfOverlayContext,
  PdfPlacementGesture,
  PdfViewportSettledState,
} from '../features/pdf/components/PdfViewport';
import {
  PdfRenderCache,
  pageRenderKey,
  regionRenderKey,
  renderRevisionKey,
} from '../features/pdf/pdfRenderCache';
import {
  chooseDetailRender,
  choosePageRenderScale,
  detailRenderCovers,
} from '../features/pdf/pdfRenderScale';
import { PdfTextEditModal } from '../features/pdf/components/PdfTextEditModal';
import { PdfPagesSheet } from '../features/pdf/components/PdfPagesSheet';
import { PdfSearchBar, PdfSearchResultsList } from '../features/pdf/components/PdfSearchPanel';
import {
  PdfDocumentOperation,
  PdfSearchResult,
  getPdfPageChars,
  getPdfPageText,
  prepareImageForPdf,
  purgePdfThumbnails,
} from '../features/pdf/pdfDocumentOperations';
import { fontWeights, spacing, typography } from '../constants/theme';
import { documentStorage } from '../storage';
import { Document } from '../types/document';
import {
  buildWorkingCopyPath,
  cleanupPdfSessionFiles,
  createDurablePdfRevisionPath,
  createPdfDocumentId,
  deleteReleasedRevisionFiles,
  discardImportedPdf,
  ensureDurablePdfSource,
  getPdfSessionWorkingDirectory,
  pruneDurablePdfRevisions,
} from '../features/pdf/pdfDocumentFiles';
import {
  PdfOpenFailure,
  describePdfOpenError,
  describePdfOutputError,
  savePdfAs,
  sharePdf,
} from '../features/pdf/pdfOutputService';
import { documentActivity } from '../features/documents/documentActivity';
import { displayTitle } from '../features/library/libraryService';
import { useTheme } from '../ui/ThemeProvider';
import { Icon } from '../ui/Icon';
import { BackButton, BarButton, EmptyState, NavBar, PillButton, Toolbar, ToolbarItem } from '../ui/controls';
import { showActionSheet, showAlert, showPrompt, showToast } from '../ui/overlays';
import { haptic } from '../ui/haptics';
import { copyText } from '../ui/clipboard';
import { EditMenu, EditMenuColorChooser, EditMenuItem, HintPill } from '../ui/EditMenu';
import {
  PdfCharRange,
  PdfPageChars,
  charAtPoint,
  normalizeRange,
  planRangeEdit,
  rangeHandles,
  rangeMarkOperation,
  rangeRects,
  rangeText,
  wordRangeAt,
} from '../features/pdf/pdfCharSelection';
import {
  DEFAULT_PDF_TEXT_STYLE,
  PdfTextBoxDraft,
  PdfTextBoxStyle,
  clampDraftToPage,
  displayBaselineY,
  draftForRect,
  draftFromTextObject,
  isMovableTextObject,
  layoutPdfTextBox,
  textBoxFormat,
  textBoxRect,
  uiFamilyOf,
} from '../features/pdf/pdfTextBox';
import { displayMatrixForPage } from '../features/pdf/pdfPageGeometry';
import { PdfDisplayMatrix } from '../features/pdf/types';
import { PdfTextEditExtras } from '../features/pdf/components/PdfTextEditModal';
import { platformFontFamily } from '../features/text/textLayout';
import {
  ANNOTATION_SWATCHES,
  ANNOTATION_STYLE_LABELS,
  PdfTextMarkStyle,
  selectionMarkRects,
  selectionText,
  textMarkOperation,
} from '../features/pdf/pdfTextSelection';
import { appSettings, useAppSettings } from '../settings/appSettings';
import { InkLayer, InkItem } from '../components/markup/InkLayer';
import { MarkupToolbar } from '../components/markup/MarkupToolbar';
import { SignatureSheet } from '../components/markup/SignatureSheet';
import {
  MARKUP_WIDTHS,
  MarkupDrawing,
  MarkupTool,
  drawingFromGesture,
  previewCommands,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTH_FACTOR,
} from '../features/markup/markupModel';
import { Bounds, Point, fitStrokesInto, rectCommands } from '../features/markup/inkPath';
import { SavedSignature } from '../features/markup/signatureStore';
import { pickImageFromLibrary } from '../features/image/importService';
import {
  PdfOcrRegion,
  buildOcrEditOperations,
  hitTestOcrRegions,
  isLikelyScannedPage,
  ocrPageText,
  recognizePdfPage,
  searchOcrPages,
  unsupportedOcrReplacementChars,
} from '../features/pdf/pdfOcr';
import { operationKind } from '../features/pdf/pdfDocumentOperations';
import { describeChars } from '../features/pdf/pdfGlyphCoverage';

/**
 * Registers (or re-points) the library record of a freshly imported PDF at its durable
 * copy. A record write failure does not block editing; the next Save writes the record.
 */
async function registerImportedPdf(
  documentId: string,
  durablePath: string,
  title: string,
  pageCount: number,
): Promise<void> {
  try {
    const now = Date.now();
    const existing = await documentStorage.getDocument(documentId).catch(() => null);
    const record: Document = {
      id: documentId,
      metadata: {
        id: documentId,
        title: existing?.metadata.title ?? title,
        kind: 'pdf',
        sourceUri: durablePath,
        pageCount,
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
      },
      pages: [],
    };
    await documentStorage.saveDocument(record);
  } catch (err: unknown) {
    console.warn('[PHASE12_PDF] Imported PDF could not be added to the document library:', err);
  }
}

/** Zoom detail is requested this long after a pinch/pan ends (never per frame). */
const DETAIL_SETTLE_DELAY_MS = 200;

interface PageCacheEntry {
  /** Revision identity the entry was produced from (never reused for another revision). */
  revisionKey: string;
  renderedPage: PdfRenderedPage;
  textObjects: PdfTextObject[];
  originalObjects: PdfTextObject[];
  /** Characters for selection (null when the platform cannot provide them). */
  chars: PdfPageChars | null;
  displayMatrix: PdfDisplayMatrix | null;
}

/** Editor interaction modes. */
type EditorMode = 'view' | 'placeText' | 'textBox' | 'markup' | 'place' | 'search';

/** Added text being placed (or existing PIE-added text being moved / resized). */
interface TextBoxPlacement {
  readonly draft: PdfTextBoxDraft;
  /** Objects the box replaces when written (Move / Resize of existing text). */
  readonly replaceIds: readonly string[];
}

/** Content being positioned on the page before it is written (signature or photo). */
interface PendingPlacement {
  readonly kind: 'signature' | 'image';
  readonly rect: Bounds;
  readonly signature?: SavedSignature;
  readonly image?: { readonly path: string; readonly uri: string; readonly width: number; readonly height: number };
}

const SIGNATURE_INK = '#1C1C1E';

export const PdfEditorScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  const route = useRoute<PdfEditorScreenRouteProp>();
  const navigation = useNavigation();
  const { colors } = useTheme();
  const settings = useAppSettings();

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

  // Character-level selection (Drive-style): the shown page's characters and the selected range
  const [pageChars, setPageChars] = useState<PdfPageChars | null>(null);
  const [charRange, setCharRange] = useState<PdfCharRange | null>(null);
  const charRangeRef = useRef<PdfCharRange | null>(null);
  charRangeRef.current = charRange;
  const charMode = !!pageChars && pageChars.chars.length > 0;

  // Scanned pages: text recognised on-device per page (display points) and the selected line.
  const [ocrPages, setOcrPages] = useState<Record<number, PdfOcrRegion[]>>({});
  const ocrPagesRef = useRef(ocrPages);
  ocrPagesRef.current = ocrPages;
  const [selectedOcr, setSelectedOcr] = useState<PdfOcrRegion | null>(null);
  const selectedOcrRef = useRef<PdfOcrRegion | null>(null);
  selectedOcrRef.current = selectedOcr;
  const [ocrRunning, setOcrRunning] = useState(false);
  const [scanHintDismissed, setScanHintDismissed] = useState(false);
  // A recognised line belongs to its page
  useEffect(() => {
    setSelectedOcr(null);
  }, [currentPageIndex]);

  /**
   * Tap on the page. With character selection a tap only clears the selection (long press
   * selects); without character data (fallback) a tap selects the text object under the finger.
   */
  const handleSelectObject = useCallback(
    (obj: PdfTextObject | null) => {
      setCharRange(null);
      setSelectedOcr(null);
      if (!obj) {
        setSelectedObject(null);
        setPdfSelection(null);
        return;
      }
      haptic('selection');
      setSelectedObject(obj);
      setPdfSelection(createPdfSelectionState(obj, currentPageIndex));
    },
    [currentPageIndex],
  );

  // Inline markup colour row in the edit menu (Highlight / Underline / Strikethrough)
  const [markChooser, setMarkChooser] = useState<PdfTextMarkStyle | null>(null);

  // Text box being placed / moved, and the style the next Add Text starts from
  const [textBox, setTextBox] = useState<TextBoxPlacement | null>(null);
  const textBoxStartRef = useRef<PdfTextBoxDraft | null>(null);
  const lastTextStyleRef = useRef<PdfTextBoxStyle>(DEFAULT_PDF_TEXT_STYLE);
  // User -> display matrix of the shown page (baselines for underline / move)
  const pageDisplayMatrixRef = useRef<PdfDisplayMatrix | null>(null);

  // Dynamic viewport area measurement
  const [viewportLayout, setViewportLayout] = useState<{ width: number; height: number } | null>(null);

  // Page render cache to avoid repeated PDFium rendering when paging back and forth
  const pageCacheRef = useRef<Map<number, PageCacheEntry>>(new Map());

  // Editor engine ref (holds in-memory pending edits & undo/redo)
  const editorRef = useRef<PdfDocumentEditor | null>(null);

  // Modal & Text Insertion state
  const [editModalVisible, setEditModalVisible] = useState<boolean>(false);
  const [isInsertMode, setIsInsertMode] = useState<boolean>(false);
  const [mode, setMode] = useState<EditorMode>('view');
  const isPlacementMode = mode === 'placeText';
  const [insertLocation, setInsertLocation] = useState<{ x: number; y: number }>({ x: 54, y: 120 });

  // Undo / Redo & Pending changes counter
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isDirtyState, setIsDirtyState] = useState<boolean>(false);
  const [pendingEdits, setPendingEdits] = useState<readonly PdfTextEditCommand[]>([]);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [revisionKey, setRevisionKey] = useState<string>('');

  useEffect(() => {
    setCharRange(null);
  }, [revisionKey, currentPageIndex]);

  useEffect(() => {
    setMarkChooser(null);
  }, [selectedObject, charRange]);

  // UI status / async loading states
  const [loading, setLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Classified open/import failure (password-protected, unsupported security, other)
  const [openFailure, setOpenFailure] = useState<PdfOpenFailure | null>(null);
  // Save As / Share in progress
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [operationBusy, setOperationBusy] = useState<boolean>(false);
  // Releases this screen's "document in use" mark (blocks library deletion while open)
  const activityReleaseRef = useRef<(() => void) | null>(null);

  // Sheets
  const [pagesVisible, setPagesVisible] = useState(false);
  const [signaturesVisible, setSignaturesVisible] = useState(false);

  // Markup state (strokes on the current page until Done)
  const [markupTool, setMarkupTool] = useState<MarkupTool>('pen');
  const [markupColor, setMarkupColor] = useState<string>(settings.markupColor);
  const [markupWidthIndex, setMarkupWidthIndex] = useState<number>(1);
  const [drawings, setDrawings] = useState<MarkupDrawing[]>([]);
  const [livePoints, setLivePoints] = useState<Point[]>([]);
  const livePointsRef = useRef<Point[]>([]);
  const liveFrameRef = useRef<number | null>(null);

  // Signature / image placement
  const [placement, setPlacement] = useState<PendingPlacement | null>(null);
  const placementStartRef = useRef<Bounds | null>(null);

  // Search
  const [searchResults, setSearchResults] = useState<readonly PdfSearchResult[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchListVisible, setSearchListVisible] = useState(false);

  // Lazy initialize editor instance
  const getEditor = useCallback((): PdfDocumentEditor => {
    if (!editorRef.current) {
      editorRef.current = new PdfDocumentEditor(defaultPdfiumEngine);
    }
    return editorRef.current;
  }, []);

  // Stable persisted-record id for this document (reused when reopened from Home)
  const documentIdRef = useRef<string>(route.params?.documentId || createPdfDocumentId());
  // Session directory for unsaved working copies (undefined = not resolved yet)
  const sessionDirRef = useRef<string | null | undefined>(undefined);
  const workingSeqRef = useRef<number>(0);

  /** Next working-copy path for an applied edit (flat names inside the session directory). */
  const nextWorkingCopyPath = useCallback(async (): Promise<string> => {
    const editor = getEditor();
    if (sessionDirRef.current === undefined) {
      sessionDirRef.current = await getPdfSessionWorkingDirectory(documentIdRef.current).catch(
        (e: unknown) => {
          console.warn('[PHASE11_PDF] Session working directory unavailable:', e);
          return null;
        },
      );
    }
    workingSeqRef.current += 1;
    const current = editor.getCurrentFilePath() || '';
    return buildWorkingCopyPath(current, sessionDirRef.current ?? null, workingSeqRef.current);
  }, [getEditor]);

  // Phase 15 render cache: page renders keyed by revision identity (document handle + open
  // file), page, scale and region, so a previous revision's render is never shown again.
  const renderCacheRef = useRef(new PdfRenderCache<PdfRenderedPage | PdfRenderedRegion>());
  const renderedPageRef = useRef<PdfRenderedPage | null>(null);
  // Zoom detail: sharper render of the visible region, requested once a gesture settles
  const [detailTile, setDetailTile] = useState<PdfRenderedRegion | null>(null);
  const detailTileRef = useRef<PdfRenderedRegion | null>(null);
  const detailGenerationRef = useRef(0);
  const detailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showDetailTile = useCallback((tile: PdfRenderedRegion | null) => {
    detailTileRef.current = tile;
    setDetailTile(tile);
  }, []);

  /** Deletes page renders that are no longer cached/displayed. */
  const purgeStaleRenders = useCallback(() => {
    const keep = new Set<string>([
      ...[...pageCacheRef.current.values()].map((entry) => entry.renderedPage.filePath),
      ...renderCacheRef.current.livePaths(),
    ]);
    if (detailTileRef.current) keep.add(detailTileRef.current.filePath);
    defaultPdfiumEngine.purgeRenderCache([...keep]).catch(() => {});
  }, []);

  /** Deletes revision files the editor released (pruned or abandoned undo steps). */
  const releaseRevisionFiles = useCallback(() => {
    const released = getEditor().takeDiscardedRevisionFiles();
    if (released.length > 0) {
      deleteReleasedRevisionFiles(documentIdRef.current, released).catch(() => 0);
    }
  }, [getEditor]);

  const updateHistoryState = useCallback((editor: PdfDocumentEditor) => {
    const edits = editor.getPendingEdits();
    setPendingEdits([...edits]);
    setPendingCount(edits.length);
    setCanUndo(editor.canUndo());
    setCanRedo(editor.canRedo());
    setIsDirtyState(editor.isDirty ? editor.isDirty() : edits.length > 0);
    const identity = editor.getRenderIdentity();
    setRevisionKey(identity ? renderRevisionKey(identity) : '');
  }, []);

  // Render page raster and fetch visible vector text objects (with cache)
  const loadPage = useCallback(
    async (pageIdx: number, forceBypassCache = false) => {
      try {
        setErrorMessage(null);
        setSelectedObject(null);
        setPdfSelection(null);
        setCharRange(null);

        // A different page or revision never shows a previous zoom detail
        detailGenerationRef.current += 1;
        if (detailTimerRef.current) {
          clearTimeout(detailTimerRef.current);
          detailTimerRef.current = null;
        }
        showDetailTile(null);

        const editor = getEditor();
        const identity = editor.getRenderIdentity();
        const revisionKeyNow = identity ? renderRevisionKey(identity) : '';

        // Page cache: instant page switching, but only within the same revision
        const cachedEntry = pageCacheRef.current.get(pageIdx);
        if (!forceBypassCache && cachedEntry && cachedEntry.revisionKey === revisionKeyNow) {
          renderedPageRef.current = cachedEntry.renderedPage;
          setRenderedPage(cachedEntry.renderedPage);
          setTextObjects(cachedEntry.textObjects);
          setOriginalObjects(cachedEntry.originalObjects);
          setPageChars(cachedEntry.chars);
          pageDisplayMatrixRef.current = cachedEntry.displayMatrix;
          setCurrentPageIndex(pageIdx);
          setLoading(false);
          return;
        }

        setLoading(true);
        const pageSize = await editor.getPageSize(pageIdx);
        pageDisplayMatrixRef.current = displayMatrixForPage(pageSize);

        // Renders of other revisions can never be shown again
        renderCacheRef.current.retainRevision(revisionKeyNow);

        // Base render: 2 px/pt unless the page is so large that the pixel budget applies
        const scale = choosePageRenderScale(pageSize.width, pageSize.height);
        const renderKey = identity ? pageRenderKey(identity, pageIdx, scale) : '';
        let rendered = renderKey
          ? (renderCacheRef.current.get(renderKey) as PdfRenderedPage | undefined)
          : undefined;
        if (!rendered) {
          rendered = await defaultPdfiumEngine.renderPage(identity?.docHandle ?? 0, pageIdx, { scale });
          if (renderKey) {
            renderCacheRef.current.set(renderKey, revisionKeyNow, rendered);
          }
        }
        console.log('[PHASE1_PDF] PAGE_RENDER_SUCCESS: page ' + (pageIdx + 1) + ' of ' + editor.getPageCount() + ' (' + pageSize.width + 'x' + pageSize.height + ' pt, ' + scale + ' px/pt)');

        const objects = await editor.getTextObjects(pageIdx);
        // Snapshot unedited original objects for knockout patches
        const origRaw = await defaultPdfiumEngine.getTextObjects(identity?.docHandle ?? 0, pageIdx);
        // Characters for long-press / handle selection (null: object selection fallback)
        const chars = identity ? await getPdfPageChars(identity.docHandle, pageIdx) : null;

        const newRenderedPage: PdfRenderedPage = {
          ...rendered,
          pageWidth: pageSize.width,
          pageHeight: pageSize.height,
        };

        // Cache this page (tagged with its revision)
        pageCacheRef.current.set(pageIdx, {
          revisionKey: revisionKeyNow,
          renderedPage: newRenderedPage,
          textObjects: objects,
          originalObjects: origRaw,
          chars,
          displayMatrix: pageDisplayMatrixRef.current,
        });

        renderedPageRef.current = newRenderedPage;
        setRenderedPage(newRenderedPage);
        setTextObjects(objects);
        setOriginalObjects(origRaw);
        setPageChars(chars);
        setCurrentPageIndex(pageIdx);
        updateHistoryState(editor);
        // Remove page renders that are no longer cached (previous revisions/pages)
        purgeStaleRenders();
        // Remove revision files that dropped out of the undo history
        releaseRevisionFiles();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(`Failed to load page ${pageIdx + 1}: ${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [getEditor, updateHistoryState, purgeStaleRenders, releaseRevisionFiles, showDetailTile],
  );

  /**
   * Zoom detail: once a gesture has settled, render only the visible region (plus margin) at
   * a higher scale when the base render is too coarse for the current zoom. Results for an
   * outdated page, revision or gesture are discarded.
   */
  const requestDetailRender = useCallback(
    async (state: PdfViewportSettledState) => {
      const page = renderedPageRef.current;
      const identity = getEditor().getRenderIdentity();
      if (!page || !identity || typeof defaultPdfiumEngine.renderPageRegion !== 'function') return;

      const plan = chooseDetailRender({
        page: { width: page.pageWidth, height: page.pageHeight },
        visibleRect: state.visibleRect,
        baseFitScale: state.baseFitScale,
        zoom: state.zoom,
        pixelRatio: PixelRatio.get(),
        baseRenderScale: page.scale,
      });
      if (!plan) {
        showDetailTile(null);
        return;
      }
      const current = detailTileRef.current;
      if (current && current.pageIndex === page.pageIndex && detailRenderCovers(current, plan)) {
        return;
      }

      const generation = ++detailGenerationRef.current;
      const revisionKeyNow = renderRevisionKey(identity);
      const key = regionRenderKey(identity, page.pageIndex, plan.scale, plan.rect);
      let region = renderCacheRef.current.get(key) as PdfRenderedRegion | undefined;
      if (!region) {
        try {
          region = await defaultPdfiumEngine.renderPageRegion(identity.docHandle, page.pageIndex, plan.scale, plan.rect);
        } catch (err: unknown) {
          console.warn('[PHASE15_PDF] Zoom detail render failed; keeping the base render:', err);
          return;
        }
        renderCacheRef.current.set(key, revisionKeyNow, region);
      }

      const now = getEditor().getRenderIdentity();
      if (
        generation !== detailGenerationRef.current ||
        !now ||
        renderRevisionKey(now) !== revisionKeyNow ||
        renderedPageRef.current?.pageIndex !== page.pageIndex
      ) {
        return;
      }
      showDetailTile(region);
      purgeStaleRenders();
    },
    [getEditor, showDetailTile, purgeStaleRenders],
  );

  const handleViewportSettled = useCallback(
    (state: PdfViewportSettledState) => {
      if (detailTimerRef.current) clearTimeout(detailTimerRef.current);
      detailTimerRef.current = setTimeout(() => {
        detailTimerRef.current = null;
        requestDetailRender(state);
      }, DETAIL_SETTLE_DELAY_MS);
    },
    [requestDetailRender],
  );

  useEffect(
    () => () => {
      if (detailTimerRef.current) clearTimeout(detailTimerRef.current);
      if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
    },
    [],
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
        setOpenFailure(null);
        pageCacheRef.current.clear();
        setSelectedObject(null);
        setPdfSelection(null);

        const cleanTitle = title || route.params?.fileName || path.split(/[\\/]/).pop() || 'Document.pdf';
        setCurrentPdfPath(path);
        setDocumentTitle(cleanTitle);

        const editor = getEditor();
        const previousDocumentId = documentIdRef.current;
        if (targetPath) {
          // A newly picked document gets its own persisted record id
          documentIdRef.current = createPdfDocumentId();
        }
        sessionDirRef.current = undefined;
        workingSeqRef.current = 0;

        // Phase 12: a picked PDF is copied into durable document storage BEFORE it is
        // opened, so the open document and its library record never depend on the
        // purgeable cache. Library documents (already durable) open unchanged.
        const importDocumentId = documentIdRef.current;
        const source = await ensureDurablePdfSource(path, importDocumentId);
        try {
          await editor.open(source.path);
        } catch (openErr) {
          if (source.imported) {
            discardImportedPdf(importDocumentId).catch(() => {});
          }
          throw openErr;
        }
        console.log('[PHASE1_PDF] OPEN_SUCCESS: ' + source.path);

        // The open document is "in use" until this screen has closed it and cleaned up its
        // session files; library deletion is refused meanwhile.
        activityReleaseRef.current?.();
        activityReleaseRef.current = documentActivity.markActive(importDocumentId, 'open');

        if (source.imported) {
          setCurrentPdfPath(source.path);
          await registerImportedPdf(importDocumentId, source.path, cleanTitle, editor.getPageCount());
          // The picker/content-URI cache copies are obsolete once the durable copy exists.
          defaultPdfiumEngine.purgeImportCache([]).catch(() => 0);
        }

        if (previousDocumentId !== documentIdRef.current) {
          // Previous document is closed by open(): its unsaved working copies are obsolete
          cleanupPdfSessionFiles(previousDocumentId, []).catch(() => {});
        }

        const count = editor.getPageCount();
        setPageCount(count);
        console.log('[PHASE1_PDF] PAGE_COUNT: ' + count);

        await loadPage(0, true);
      } catch (err: unknown) {
        // Password-protected / unsupported-security PDFs get a clear state; encryption is
        // never bypassed and a failed import was already discarded above.
        const failure = describePdfOpenError(err);
        setOpenFailure(failure);
        setRenderedPage(null);
        setErrorMessage(failure.message);
        setLoading(false);
      }
    },
    [route.params?.pdfPath, route.params?.fileName, getEditor, loadPage],
  );

  useEffect(() => {
    openPdfDocument();

    return () => {
      pageCacheRef.current.clear();
      const editor = editorRef.current;
      const sessionDocumentId = documentIdRef.current;
      const closed = editor ? editor.close().catch(() => {}) : Promise.resolve();
      // Only after the document is closed: drop this session's unsaved working copies and
      // cached page renders (nothing open can reference them any more).
      const releaseActivity = activityReleaseRef.current;
      activityReleaseRef.current = null;
      closed.finally(() => {
        Promise.all([
          cleanupPdfSessionFiles(sessionDocumentId, []).catch(() => {}),
          defaultPdfiumEngine.purgeRenderCache([]).catch(() => {}),
          purgePdfThumbnails().catch(() => {}),
        ]).finally(() => releaseActivity?.());
      });
    };
  }, [openPdfDocument]);

  // -------------------------------------------------------------------------
  // Page navigation
  // -------------------------------------------------------------------------

  const goToPage = useCallback(
    (index: number) => {
      const target = Math.max(0, Math.min(pageCount - 1, index));
      if (target === currentPageIndex || loading) return;
      haptic('selection');
      loadPage(target);
    },
    [pageCount, currentPageIndex, loading, loadPage],
  );

  const handleSwipePage = useCallback(
    (direction: 1 | -1) => {
      if (mode !== 'view' && mode !== 'search') return;
      goToPage(currentPageIndex + direction);
    },
    [mode, goToPage, currentPageIndex],
  );

  // -------------------------------------------------------------------------
  // Text: placement, edit, insert, delete
  // -------------------------------------------------------------------------

  // Start "+ Text" placement mode
  const handleStartPlacement = useCallback(() => {
    setSelectedObject(null);
    setPdfSelection(null);
    setMode('placeText');
  }, []);

  // When user taps location on page in placement mode
  const handlePlaceTextAt = useCallback((point: { x: number; y: number }) => {
    setMode('view');
    setInsertLocation(point);
    setIsInsertMode(true);
    setEditModalVisible(true);
  }, []);

  // Open Edit Modal for selected text
  const handleOpenEdit = useCallback(() => {
    if (!selectedObject && !charRangeRef.current) return;
    setIsInsertMode(false);
    setEditModalVisible(true);
  }, [selectedObject]);

  // Character-range edit (defined further down; reached through a ref from the modal handler)
  const rangeEditRef = useRef<(replacement: string, format?: PdfTextFormatOptions) => Promise<void>>(async () => {});

  // Apply Edit or Insert
  const handleApplyModalText = useCallback(
    async (text: string, format: PdfTextFormatOptions, extras?: PdfTextEditExtras) => {
      const editor = getEditor();
      setEditModalVisible(false);

      if (isInsertMode) {
        // Added text becomes a text box the user can drag / pinch before it is written
        if (!text.trim()) {
          showAlert('Invalid Text', 'Text cannot be empty or whitespace only.');
          return;
        }
        const style = extras?.style ?? DEFAULT_PDF_TEXT_STYLE;
        lastTextStyleRef.current = style;
        const page = renderedPageRef.current;
        setTextBox((current) => {
          const origin = current ? current.draft.origin : insertLocation;
          const next: PdfTextBoxDraft = { text, style, origin };
          return {
            draft: page ? clampDraftToPage(next, { width: page.pageWidth, height: page.pageHeight }) : next,
            replaceIds: current?.replaceIds ?? [],
          };
        });
        setIsInsertMode(false);
        setMode('textBox');
        return;
      }

      // Character selection: replace exactly the selected characters
      if (charRangeRef.current) {
        await rangeEditRef.current(text.replace(/\s*\n\s*/g, ' ').trim(), format);
        return;
      }

      if (selectedObject) {
        const trimmed = text.trim();
        if (!trimmed) {
          showAlert('Invalid Text', 'Replacement text cannot be empty or whitespace only.');
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
        setBusyLabel('Updating text…');

        // 2. Prepare internal working copy path to guarantee source PDF immutability
        const workingCopyPath = await nextWorkingCopyPath();

        try {
          // 3. Native PDFium replacement via domain editor
          if (editor.applyExistingTextReplacement) {
            const { reconciledObject } = await editor.applyExistingTextReplacement(
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
            showToast('Text updated', { tone: 'success' });
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

          const errorMsg = err instanceof Error ? err.message : String(err);
          if (err instanceof PdfFontLimitationError) {
            showAlert('Font Limitation', errorMsg);
          } else if (err instanceof PdfInvalidObjectPathError) {
            showAlert('Text Not Editable', errorMsg);
          } else if (err instanceof PdfUnsupportedReplacementError) {
            showAlert('Unsupported Replacement', errorMsg);
          } else if (err instanceof PdfInvalidReplacementError) {
            showAlert('Invalid Text', errorMsg);
          } else {
            showAlert('Replacement Failed', errorMsg);
          }
        } finally {
          setBusyLabel(null);
        }
      }
    },
    [
      getEditor,
      isInsertMode,
      insertLocation,
      selectedObject,
      currentPageIndex,
      loadPage,
      updateHistoryState,
      nextWorkingCopyPath,
    ],
  );

  const objectsById = useMemo(() => new Map(textObjects.map((o) => [o.id, o])), [textObjects]);
  /** What Delete would do with the character selection (also tells which objects it touches). */
  const charDeletePlan = useMemo(
    () => (pageChars && charRange ? planRangeEdit(pageChars, charRange, '', objectsById) : null),
    [pageChars, charRange, objectsById],
  );
  const charPlanOk = charDeletePlan && !('error' in charDeletePlan) ? charDeletePlan : null;
  /** Text objects in the selection: those the character range touches, or the tapped object. */
  const selectionObjects: readonly PdfTextObject[] = useMemo(() => {
    if (charRange) {
      return charPlanOk
        ? charPlanOk.objectIds.map((id) => objectsById.get(id)).filter((o): o is PdfTextObject => !!o)
        : [];
    }
    return selectedObject ? [selectedObject] : [];
  }, [charRange, charPlanOk, objectsById, selectedObject]);
  const hasSelection = !!charRange || !!selectedObject;
  const wholeObjectsSelected = !charRange || !!charPlanOk?.wholeObjects;
  const selectedText = useMemo(
    () => (charRange && pageChars ? rangeText(pageChars, charRange) : selectionText(selectionObjects)),
    [charRange, pageChars, selectionObjects],
  );
  const selectionRects = useMemo(
    () => (charRange && pageChars ? rangeRects(pageChars, charRange) : selectionMarkRects(selectionObjects)),
    [charRange, pageChars, selectionObjects],
  );
  const selectionHandles = useMemo(
    () => (charRange && pageChars ? rangeHandles(pageChars, charRange) : null),
    [charRange, pageChars],
  );

  // One-time tip: how to select text (until the first long press)
  const settingsTipSeen = useAppSettings().pdfSelectionTipSeen;

  /** Long press: select the word under the finger. */
  const handleLongPressDoc = useCallback(
    (point: { x: number; y: number }) => {
      if (!pageChars || mode !== 'view') return;
      const idx = charAtPoint(pageChars, point, 12);
      if (idx === null) return;
      haptic('medium');
      setSelectedObject(null);
      setPdfSelection(null);
      setCharRange(wordRangeAt(pageChars, idx));
      if (!appSettings.get().pdfSelectionTipSeen) appSettings.update({ pdfSelectionTipSeen: true });
    },
    [pageChars, mode],
  );

  /** Dragging a selection handle: the other end stays put; crossing over swaps naturally. */
  const dragAnchorRef = useRef<number | null>(null);
  const handleHandleDrag = useCallback(
    (which: 'start' | 'end', point: { x: number; y: number }, phase: 'start' | 'move' | 'end') => {
      const current = charRangeRef.current;
      if (!pageChars || !current) return;
      if (phase === 'start' || dragAnchorRef.current === null) {
        dragAnchorRef.current = which === 'start' ? current.end : current.start;
      }
      const idx = charAtPoint(pageChars, point);
      if (idx !== null) {
        const next = normalizeRange(dragAnchorRef.current, idx);
        if (next.start !== current.start || next.end !== current.end) {
          haptic('selection');
          setCharRange(next);
        }
      }
      if (phase === 'end') dragAnchorRef.current = null;
    },
    [pageChars],
  );

  const handleSelectAll = useCallback(() => {
    if (!pageChars || pageChars.chars.length === 0) return;
    haptic('selection');
    setSelectedObject(null);
    setPdfSelection(null);
    setCharRange({ start: 0, end: pageChars.chars.length - 1 });
  }, [pageChars]);

  const performDelete = useCallback(
    async (target: PdfTextObject) => {
      const editor = getEditor();
      // Prepare internal working copy path to guarantee source PDF immutability
      const workingCopyPath = await nextWorkingCopyPath();
      setBusyLabel('Deleting text…');
      try {
        if (editor.applyExistingTextDeletion) {
          await editor.applyExistingTextDeletion(target.id, workingCopyPath);
          // 1. Switch active session to working copy
          setCurrentPdfPath(workingCopyPath);
          pageCacheRef.current.clear();
          // 2. Clear selection state
          setSelectedObject(null);
          setPdfSelection(null);
          // 3. Re-render affected page from working copy
          await loadPage(currentPageIndex, true);
          // 4. Update status and history
          showToast('Text deleted');
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
        // Target remains selected on failure
        setSelectedObject(target);
        setPdfSelection(createPdfSelectionState(target, currentPageIndex));
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof PdfInvalidObjectPathError) {
          showAlert('Text Not Editable', errorMsg);
        } else if (err instanceof PdfNonDeletableObjectError) {
          showAlert('Cannot Delete', errorMsg);
        } else if (err instanceof PdfTextDeletionError) {
          showAlert('Deletion Failed', errorMsg);
        } else {
          showAlert('Delete Error', errorMsg);
        }
      } finally {
        setBusyLabel(null);
      }
    },
    [getEditor, nextWorkingCopyPath, loadPage, currentPageIndex, updateHistoryState],
  );

  /**
   * Replaces the selected characters (an empty replacement deletes them) as ONE revision: the
   * touched text objects are rewritten / removed and the rest of the line reflows natively.
   */
  const performRangeEdit = useCallback(
    async (replacement: string, format?: PdfTextFormatOptions) => {
      const range = charRangeRef.current;
      if (!pageChars || !range) return;
      const plan = planRangeEdit(pageChars, range, replacement, objectsById);
      if ('error' in plan) {
        showAlert('Cannot Edit This Text', plan.error);
        return;
      }
      const editor = getEditor();
      const workingCopyPath = await nextWorkingCopyPath();
      setBusyLabel(replacement ? 'Updating text…' : 'Deleting text…');
      try {
        await editor.applyTextRangeEdit(plan.items, workingCopyPath, plan.wholeObjects ? format : undefined);
        setCurrentPdfPath(workingCopyPath);
        pageCacheRef.current.clear();
        setCharRange(null);
        setSelectedObject(null);
        setPdfSelection(null);
        await loadPage(currentPageIndex, true);
        showToast(replacement ? 'Text updated' : 'Text deleted', replacement ? { tone: 'success' } : undefined);
        updateHistoryState(editor);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const title =
          err instanceof PdfFontLimitationError
            ? 'Font Limitation'
            : err instanceof PdfInvalidObjectPathError
              ? 'Text Not Editable'
              : replacement
                ? 'Edit Failed'
                : 'Deletion Failed';
        showAlert(title, errorMsg);
        updateHistoryState(editor);
      } finally {
        setBusyLabel(null);
      }
    },
    [pageChars, objectsById, getEditor, nextWorkingCopyPath, loadPage, currentPageIndex, updateHistoryState],
  );
  rangeEditRef.current = performRangeEdit;

  // Delete the selected text (character range, or the tapped object in fallback mode)
  const handleDeleteSelected = useCallback(() => {
    if (!hasSelection) return;
    const run = () => {
      if (charRangeRef.current) performRangeEdit('');
      else if (selectedObject) performDelete(selectedObject);
    };
    if (!appSettings.get().confirmDestructive) {
      run();
      return;
    }
    const preview = selectedText.replace(/\s+/g, ' ').slice(0, 80);
    showAlert('Delete Text?', `“${preview}” will be removed from the page.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: run },
    ]);
  }, [hasSelection, selectedObject, selectedText, performRangeEdit, performDelete]);

  const handleCopySelected = useCallback(async () => {
    if (!selectedText) return;
    const ok = await copyText(selectedText);
    showToast(ok ? 'Copied' : 'Copy is not available', { icon: ok ? 'check' : undefined });
  }, [selectedText]);

  /** The selection can be moved / resized: whole standard-font objects PIE can re-insert. */
  const movableSelection = useMemo(() => {
    if (!wholeObjectsSelected || selectionObjects.length === 0 || !selectionObjects.every(isMovableTextObject)) return false;
    const first = selectionObjects[0];
    return selectionObjects.every(
      (o) => o.fontName === first.fontName && (o.color || '') === (first.color || '') && Math.abs((o.fontSize ?? 0) - (first.fontSize ?? 0)) < 0.01,
    );
  }, [wholeObjectsSelected, selectionObjects]);

  const handleMoveSelected = useCallback(() => {
    if (!movableSelection) return;
    const first = [...selectionObjects].sort((a, b) => a.bounds.x - b.bounds.x)[0];
    const base = draftFromTextObject(first, pageDisplayMatrixRef.current);
    if (!base) return;
    const draft: PdfTextBoxDraft = { ...base, text: selectedText.replace(/\s*\n\s*/g, ' ') };
    setTextBox({ draft, replaceIds: selectionObjects.map((o) => o.id) });
    setSelectedObject(null);
    setPdfSelection(null);
    setCharRange(null);
    setMode('textBox');
  }, [movableSelection, selectionObjects, selectedText]);

  // -------------------------------------------------------------------------
  // Page tools & markup (document operations -> one undoable revision each)
  // -------------------------------------------------------------------------

  const applyOperations = useCallback(
    async (ops: readonly PdfDocumentOperation[], successMessage: string, nextPage?: number): Promise<boolean> => {
      const editor = getEditor();
      if (operationBusy || isSaving) return false;
      setOperationBusy(true);
      setBusyLabel('Applying…');
      try {
        const workingCopyPath = await nextWorkingCopyPath();
        await editor.applyDocumentOperations(ops, workingCopyPath);
        if (ops.some((op) => operationKind(op) === 'pages')) {
          // Page order / rotation changed: recognised positions no longer apply.
          setOcrPages({});
          setSelectedOcr(null);
        }
        const count = editor.getPageCount();
        setPageCount(count);
        setCurrentPdfPath(workingCopyPath);
        pageCacheRef.current.clear();
        const target = Math.max(0, Math.min(count - 1, nextPage ?? currentPageIndex));
        await loadPage(target, true);
        updateHistoryState(editor);
        showToast(successMessage, { tone: 'success' });
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showAlert('Could Not Apply', msg);
        updateHistoryState(editor);
        return false;
      } finally {
        setOperationBusy(false);
        setBusyLabel(null);
      }
    },
    [getEditor, operationBusy, isSaving, nextWorkingCopyPath, currentPageIndex, loadPage, updateHistoryState],
  );

  const handleMarkSelected = useCallback(
    (style: PdfTextMarkStyle) => {
      const color = appSettings.get().annotationColors[style];
      const label = style === 'highlight' ? 'Highlighted' : style === 'underline' ? 'Underlined' : 'Struck through';
      const range = charRangeRef.current;
      if (range && pageChars) {
        // Exact characters, one band per line, underline / strikethrough from the baselines
        applyOperations([rangeMarkOperation(pageChars, range, style, color)], label);
        return;
      }
      if (selectionObjects.length === 0) return;
      const matrix = pageDisplayMatrixRef.current;
      applyOperations(
        [textMarkOperation(style, currentPageIndex, selectionObjects, color, (o) => displayBaselineY(o, matrix))],
        label,
      );
    },
    [pageChars, selectionObjects, currentPageIndex, applyOperations],
  );

  // Markup drawing
  const markupWidth = MARKUP_WIDTHS[markupWidthIndex] ?? 3;

  const startMarkup = useCallback(() => {
    setSelectedObject(null);
    setPdfSelection(null);
    setDrawings([]);
    setLivePoints([]);
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
    const drawing = drawingFromGesture(markupTool, pts, { color: markupColor, width: markupWidth }, 3);
    if (drawing) setDrawings((d) => [...d, drawing]);
  }, [markupTool, markupColor, markupWidth]);

  const finishMarkup = useCallback(async () => {
    if (drawings.length === 0) {
      setMode('view');
      return;
    }
    const ops: PdfDocumentOperation[] = [];
    for (const d of drawings) {
      if (d.kind === 'shape' && d.shape && d.rect) {
        ops.push({ type: 'addShape', pageIndex: currentPageIndex, shape: d.shape, rect: d.rect, color: d.color, width: d.width, opacity: d.opacity });
      } else {
        ops.push({
          type: 'addInk',
          pageIndex: currentPageIndex,
          strokes: [d.commands],
          color: d.color,
          width: d.width,
          opacity: d.opacity,
          blendMode: d.kind === 'highlighter' ? 'Multiply' : undefined,
        });
      }
    }
    const ok = await applyOperations(ops, 'Markup added');
    if (ok) {
      setDrawings([]);
      setMode('view');
      appSettings.update({ markupColor: /^#[0-9a-fA-F]{6}$/.test(markupColor) ? markupColor : appSettings.get().markupColor });
    }
  }, [drawings, currentPageIndex, applyOperations, markupColor]);

  const cancelMarkup = useCallback(() => {
    if (drawings.length === 0) {
      setMode('view');
      return;
    }
    showAlert('Discard Markup?', 'Your drawings on this page will be removed.', [
      { text: 'Keep Drawing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          setDrawings([]);
          setMode('view');
        },
      },
    ]);
  }, [drawings.length]);

  // Text box placement: drag moves, pinch resizes (font size follows the box height)
  const onTextBoxGesture = useCallback((g: PdfPlacementGesture) => {
    setTextBox((current) => {
      if (!current) return current;
      const page = renderedPageRef.current;
      if (g.phase === 'start') {
        textBoxStartRef.current = current.draft;
        return current;
      }
      const base = textBoxStartRef.current ?? current.draft;
      const r = textBoxRect(base);
      const s = Math.max(0.2, Math.min(6, g.scale));
      const width = r.width * s;
      const height = r.height * s;
      const rect = {
        x: r.x + r.width / 2 - width / 2 + g.dx,
        y: r.y + r.height / 2 - height / 2 + g.dy,
        width,
        height,
      };
      let draft = g.scale !== 1 ? draftForRect(base, rect) : { ...base, origin: { x: rect.x, y: rect.y } };
      if (page) draft = clampDraftToPage(draft, { width: page.pageWidth, height: page.pageHeight });
      if (g.phase === 'end') textBoxStartRef.current = null;
      return { ...current, draft };
    });
  }, []);

  const cancelTextBox = useCallback(() => {
    setTextBox(null);
    textBoxStartRef.current = null;
    setMode('view');
  }, []);

  /** Writes the text box into the page: one native batch, one undo step. */
  const confirmTextBox = useCallback(async () => {
    if (!textBox || operationBusy) return;
    const editor = getEditor();
    const { draft, replaceIds } = textBox;
    const layout = layoutPdfTextBox(draft);
    if (layout.lines.length === 0) {
      cancelTextBox();
      return;
    }
    setOperationBusy(true);
    setBusyLabel(replaceIds.length > 0 ? 'Moving text…' : 'Adding text…');
    try {
      const workingCopyPath = await nextWorkingCopyPath();
      const { insertedObjects } = await editor.applyTextBoxInsertion(
        currentPageIndex,
        layout.lines.map((l) => ({ text: l.text, position: { x: l.x, y: l.y } })),
        workingCopyPath,
        textBoxFormat(draft.style),
        replaceIds,
      );
      setCurrentPdfPath(workingCopyPath);
      pageCacheRef.current.clear();
      setTextBox(null);
      setMode('view');
      await loadPage(currentPageIndex, true);
      const first = insertedObjects[0];
      if (first) {
        setSelectedObject(first);
        setPdfSelection(createPdfSelectionState(first, currentPageIndex));
      }
      updateHistoryState(editor);
      showToast(replaceIds.length > 0 ? 'Text moved' : 'Text added', { tone: 'success' });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof PdfFontLimitationError) {
        showAlert('Font Not Supported', errorMsg);
      } else if (err instanceof PdfInvalidPlacementError) {
        showAlert('Invalid Placement', errorMsg);
      } else {
        showAlert(replaceIds.length > 0 ? 'Could Not Move Text' : 'Could Not Add Text', errorMsg);
      }
      updateHistoryState(editor);
    } finally {
      setOperationBusy(false);
      setBusyLabel(null);
    }
  }, [textBox, operationBusy, getEditor, cancelTextBox, nextWorkingCopyPath, currentPageIndex, loadPage, updateHistoryState]);

  /** Re-opens the Edit Text panel for the text box being placed. */
  const editTextBox = useCallback(() => {
    if (!textBox) return;
    setIsInsertMode(true);
    setEditModalVisible(true);
  }, [textBox]);

  // Signature / image placement
  const startPlacement = useCallback(
    (kind: 'signature' | 'image', aspect: number, extra: Partial<PendingPlacement>) => {
      const page = renderedPageRef.current;
      if (!page) return;
      const w = Math.min(page.pageWidth * (kind === 'signature' ? 0.4 : 0.5), 260);
      const h = w / Math.max(0.05, aspect);
      const rect = { x: (page.pageWidth - w) / 2, y: (page.pageHeight - h) / 2, width: w, height: h };
      setSelectedObject(null);
      setPdfSelection(null);
      setPlacement({ kind, rect, ...extra } as PendingPlacement);
      setMode('place');
    },
    [],
  );

  const handleChooseSignature = useCallback(
    (sig: SavedSignature) => {
      setSignaturesVisible(false);
      startPlacement('signature', sig.width / sig.height, { signature: sig });
    },
    [startPlacement],
  );

  const handleAddImage = useCallback(async () => {
    try {
      const picked = await pickImageFromLibrary();
      if (!picked) return;
      setBusyLabel('Preparing image…');
      const prepared = await prepareImageForPdf(picked.uri);
      startPlacement('image', prepared.width / prepared.height, {
        image: { path: prepared.path, uri: `file://${prepared.path}`, width: prepared.width, height: prepared.height },
      });
    } catch (err: unknown) {
      showAlert('Unable to Add Image', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyLabel(null);
    }
  }, [startPlacement]);

  const onPlacementGesture = useCallback((g: PdfPlacementGesture) => {
    setPlacement((current) => {
      if (!current) return current;
      const page = renderedPageRef.current;
      if (g.phase === 'start') {
        placementStartRef.current = current.rect;
        return current;
      }
      const base = placementStartRef.current ?? current.rect;
      let { x, y, width, height } = base;
      if (g.scale !== 1) {
        const s = Math.max(0.2, Math.min(4, g.scale));
        const cx = x + width / 2;
        const cy = y + height / 2;
        width = Math.max(24, base.width * s);
        height = width * (base.height / base.width);
        x = cx - width / 2;
        y = cy - height / 2;
      }
      x += g.dx;
      y += g.dy;
      if (page) {
        width = Math.min(width, page.pageWidth);
        height = Math.min(height, page.pageHeight);
        x = Math.max(0, Math.min(page.pageWidth - width, x));
        y = Math.max(0, Math.min(page.pageHeight - height, y));
      }
      if (g.phase === 'end') placementStartRef.current = null;
      return { ...current, rect: { x, y, width, height } };
    });
  }, []);

  const confirmPlacement = useCallback(async () => {
    if (!placement) return;
    let op: PdfDocumentOperation;
    if (placement.kind === 'signature' && placement.signature) {
      const sig = placement.signature;
      const strokes = fitStrokesInto(sig.strokes, placement.rect);
      const scale = placement.rect.height / sig.height;
      op = {
        type: 'addInk',
        pageIndex: currentPageIndex,
        strokes,
        color: SIGNATURE_INK,
        width: Math.max(0.6, sig.strokeRatio * sig.height * scale),
      };
    } else if (placement.kind === 'image' && placement.image) {
      op = { type: 'addImage', pageIndex: currentPageIndex, imagePath: placement.image.path, rect: placement.rect };
    } else {
      return;
    }
    const ok = await applyOperations([op], placement.kind === 'signature' ? 'Signature added' : 'Image added');
    if (ok) {
      setPlacement(null);
      setMode('view');
    }
  }, [placement, currentPageIndex, applyOperations]);

  const cancelPlacement = useCallback(() => {
    setPlacement(null);
    setMode('view');
  }, []);

  // Search
  const selectSearchResult = useCallback(
    (index: number) => {
      const result = searchResults[index];
      if (!result) return;
      setSearchIndex(index);
      setSearchListVisible(false);
      if (result.pageIndex !== currentPageIndex) loadPage(result.pageIndex);
    },
    [searchResults, currentPageIndex, loadPage],
  );

  const closeSearch = useCallback(() => {
    setSearchResults([]);
    setSearchIndex(0);
    setSearchListVisible(false);
    setMode('view');
  }, []);

  // -------------------------------------------------------------------------
  // Undo / redo
  // -------------------------------------------------------------------------

  const afterHistoryChange = useCallback(
    async (editor: PdfDocumentEditor) => {
      pageCacheRef.current.clear();
      const activePath = editor.getCurrentFilePath();
      if (activePath) setCurrentPdfPath(activePath);
      const count = editor.getPageCount();
      setPageCount(count);
      await loadPage(Math.min(currentPageIndex, count - 1), true);
      setSelectedObject(null);
      setPdfSelection(null);
      // The page content changed under the recognised text: detect again when needed.
      setOcrPages({});
      setSelectedOcr(null);
      updateHistoryState(editor);
    },
    [currentPageIndex, loadPage, updateHistoryState],
  );

  // Undo action
  const handleUndo = useCallback(async () => {
    const editor = getEditor();
    if (!editor.canUndo() || isSaving || operationBusy) return;
    try {
      // Undo of an applied edit reopens the previous PDF revision; re-render from it.
      await editor.undo();
      await afterHistoryChange(editor);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Undo Failed', msg);
      updateHistoryState(editor);
    }
  }, [getEditor, isSaving, operationBusy, afterHistoryChange, updateHistoryState]);

  // Redo action
  const handleRedo = useCallback(async () => {
    const editor = getEditor();
    if (!editor.canRedo() || isSaving || operationBusy) return;
    try {
      // Redo of an applied edit reopens the next PDF revision; re-render from it.
      await editor.redo();
      await afterHistoryChange(editor);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Redo Failed', msg);
      updateHistoryState(editor);
    }
  }, [getEditor, isSaving, operationBusy, afterHistoryChange, updateHistoryState]);

  // -------------------------------------------------------------------------
  // Save / Save As / Share
  // -------------------------------------------------------------------------

  // Save edited PDF (durable revision + persisted record). Returns the verified saved path,
  // or null when nothing was saved. `announce` shows the completion toast (normal Save);
  // Save As / Share save silently first and then export the verified result.
  const performSave = useCallback(async (announce: boolean): Promise<string | null> => {
    const editor = getEditor();
    if (isSaving || !editor.isDirty()) return null;

    const releaseSaving = documentActivity.markActive(documentIdRef.current, 'saving');
    try {
      setIsSaving(true);
      setBusyLabel('Saving…');

      const docId = documentIdRef.current;

      // 1. Choose the output: a new durable revision inside the document's storage
      //    directory, or (no durable storage on this platform) a sibling "_edited" file.
      let outputPath = await createDurablePdfRevisionPath(docId).catch(() => null);
      if (!outputPath) {
        outputPath = editor.deriveDefaultOutputPath();
        if (outputPath === editor.getSourceFilePath() || outputPath === editor.getCurrentFilePath()) {
          outputPath = outputPath.replace(/\.pdf$/i, `_${Date.now()}.pdf`);
        }
      }

      // 2. Persist all edits (applied revisions + queued commands) with native verification
      const { outputPath: savedPath } = await editor.saveDocument(outputPath);

      // 3. Register / update the persisted record (stable id: one record per document)
      const now = Date.now();
      const existing = await documentStorage.getDocument(docId).catch(() => null);
      const savedDoc: Document = {
        id: docId,
        metadata: {
          id: docId,
          title: existing?.metadata.title || documentTitle || savedPath.split(/[\\/]/).pop() || 'Document.pdf',
          kind: 'pdf',
          sourceUri: savedPath,
          pageCount: editor.getPageCount(),
          createdAt: existing?.metadata.createdAt ?? now,
          updatedAt: now,
        },
        pages: [],
      };
      let recordWarning: string | null = null;
      try {
        await documentStorage.saveDocument(savedDoc);
      } catch (recordErr: unknown) {
        recordWarning = recordErr instanceof Error ? recordErr.message : String(recordErr);
        console.warn('[PHASE11_PDF] Saved PDF but could not update the document library:', recordErr);
      }

      // 4. Clean up: older saved revisions and this session's working copies are obsolete.
      //    Everything the editor can still open (source, saved file) stays protected.
      const protectedPaths = editor.getProtectedFilePaths();
      await pruneDurablePdfRevisions(docId, [savedPath, ...protectedPaths]).catch(() => 0);
      await cleanupPdfSessionFiles(docId, protectedPaths).catch(() => 0);
      sessionDirRef.current = undefined;

      // 5. Clear entire cache and selection; re-render from the saved document
      pageCacheRef.current.clear();
      setCurrentPdfPath(savedPath);
      setSelectedObject(null);
      setPdfSelection(null);
      await loadPage(currentPageIndex, true);
      updateHistoryState(editor);

      if (recordWarning) {
        showAlert('Saved', `Your PDF changes have been saved, but the Library could not be updated: ${recordWarning}`);
      } else if (announce) {
        showToast('Saved', { tone: 'success' });
      }
      return savedPath;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Save Failed', `${msg}\n\nYour edits are still open and can be saved again.`);
      updateHistoryState(editor);
      return null;
    } finally {
      setIsSaving(false);
      setBusyLabel(null);
      releaseSaving();
    }
  }, [isSaving, getEditor, documentTitle, loadPage, currentPageIndex, updateHistoryState]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    return (await performSave(true)) !== null;
  }, [performSave]);

  /**
   * Save As / Share only ever expose the saved, verified PDF: unsaved edits are first saved
   * with the normal verified Save. Returns false when that save failed (already reported).
   */
  const saveBeforeOutput = useCallback(async (): Promise<boolean> => {
    const editor = getEditor();
    if (!editor.isDirty()) return true;
    return (await performSave(false)) !== null;
  }, [getEditor, performSave]);

  const handleSaveAs = useCallback(async () => {
    if (isSaving || isExporting) return;
    const editor = getEditor();
    if (!(await saveBeforeOutput())) return;
    const releaseExport = documentActivity.markActive(documentIdRef.current, 'exporting');
    try {
      setIsExporting(true);
      const outcome = await savePdfAs(editor, defaultPdfiumEngine, documentTitle);
      if (outcome.status === 'saved') {
        const name = outcome.copy.displayName || 'the chosen location';
        showToast(`Saved a copy as “${name}”`, { tone: 'success' });
      }
    } catch (err: unknown) {
      showAlert('Save As Failed', describePdfOutputError(err));
    } finally {
      setIsExporting(false);
      releaseExport();
    }
  }, [isSaving, isExporting, getEditor, saveBeforeOutput, documentTitle]);

  const handleShare = useCallback(async () => {
    if (isSaving || isExporting) return;
    const editor = getEditor();
    if (!(await saveBeforeOutput())) return;
    const releaseExport = documentActivity.markActive(documentIdRef.current, 'exporting');
    try {
      setIsExporting(true);
      await sharePdf(editor, defaultPdfiumEngine, documentTitle);
    } catch (err: unknown) {
      showAlert('Share Failed', describePdfOutputError(err));
    } finally {
      setIsExporting(false);
      releaseExport();
    }
  }, [isSaving, isExporting, getEditor, saveBeforeOutput, documentTitle]);

  // -------------------------------------------------------------------------
  // Scanned pages: on-device text recognition
  // -------------------------------------------------------------------------

  const handleDetectText = useCallback(async () => {
    const identity = getEditor().getRenderIdentity();
    const page = renderedPageRef.current;
    if (!identity || !page || ocrRunning || operationBusy) return;
    setOcrRunning(true);
    setBusyLabel('Recognising text…');
    handleSelectObject(null);
    try {
      const result = await recognizePdfPage(identity.docHandle, page.pageIndex, page.pageWidth, page.pageHeight);
      setOcrPages((pages) => ({ ...pages, [page.pageIndex]: [...result.regions] }));
      if (result.regions.length === 0) {
        showAlert(
          'No Text Found',
          'No readable text was found on this page. Recognition works best on clear, straight scans of printed Latin-script text.',
        );
      } else {
        showToast(`Found ${result.regions.length} ${result.regions.length === 1 ? 'line' : 'lines'} · tap text to select`, { icon: 'scanText' });
      }
    } catch (err: unknown) {
      showAlert('Text Recognition Failed', err instanceof Error ? err.message : String(err));
    } finally {
      setOcrRunning(false);
      setBusyLabel(null);
    }
  }, [getEditor, ocrRunning, operationBusy, handleSelectObject]);

  /** Tap on a page with recognised text: select the line under the finger. */
  const handleTapPoint = useCallback(
    (point: { x: number; y: number }, tolerance: number): boolean => {
      const regions = ocrPagesRef.current[currentPageIndex];
      if (!regions || regions.length === 0) return false;
      const hit = hitTestOcrRegions(regions, point, tolerance);
      if (hit) {
        haptic('selection');
        handleSelectObject(null);
        setSelectedOcr(hit);
        return true;
      }
      if (selectedOcrRef.current) {
        setSelectedOcr(null);
        return true;
      }
      return false;
    },
    [currentPageIndex, handleSelectObject],
  );

  /** Removes (newText === null) or replaces a recognised line: one undoable revision. */
  const applyOcrEdit = useCallback(
    async (region: PdfOcrRegion, newText: string | null) => {
      const identity = getEditor().getRenderIdentity();
      const page = renderedPageRef.current;
      if (!identity || !page) return;
      let ops: PdfDocumentOperation[];
      setBusyLabel(newText === null ? 'Removing text…' : 'Replacing text…');
      try {
        ops = await buildOcrEditOperations(identity.docHandle, region, page.pageWidth, page.pageHeight, newText, {
          neighbours: ocrPagesRef.current[region.pageIndex] ?? [],
        });
      } catch (err: unknown) {
        setBusyLabel(null);
        showAlert('Could Not Edit Text', err instanceof Error ? err.message : String(err));
        return;
      }
      setBusyLabel(null);
      const ok = await applyOperations(ops, newText === null ? 'Text removed' : 'Text replaced');
      if (ok) {
        setSelectedOcr(null);
        setOcrPages((pages) => ({
          ...pages,
          [region.pageIndex]: (pages[region.pageIndex] ?? []).filter((r) => r.id !== region.id),
        }));
      }
    },
    [getEditor, applyOperations],
  );

  const handleEditOcr = useCallback(() => {
    const region = selectedOcrRef.current;
    if (!region) return;
    showPrompt({
      title: 'Edit Text',
      message: 'The scanned text is covered with its rebuilt background and your text is written in its place.',
      defaultValue: region.text,
      confirmLabel: 'Replace',
      autoCapitalize: 'none',
      validate: (value) => {
        if (!value.trim()) return 'Enter the new text, or use Delete to remove it.';
        const bad = unsupportedOcrReplacementChars(value);
        return bad.length > 0 ? `These characters can't be written in a PDF standard font: ${describeChars(bad)}` : null;
      },
      onConfirm: (value) => {
        if (value.trim() === region.text.trim()) return;
        applyOcrEdit(region, value);
      },
    });
  }, [applyOcrEdit]);

  const handleDeleteOcr = useCallback(() => {
    const region = selectedOcrRef.current;
    if (!region) return;
    if (!appSettings.get().confirmDestructive) {
      applyOcrEdit(region, null);
      return;
    }
    showAlert('Remove Text?', 'The scanned text is covered with its rebuilt background. You can undo this.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => applyOcrEdit(region, null) },
    ]);
  }, [applyOcrEdit]);

  const handleCopyOcr = useCallback(async (all: boolean) => {
    const region = selectedOcrRef.current;
    const text = all ? ocrPageText(ocrPagesRef.current[currentPageIndex] ?? []) : region?.text ?? '';
    if (!text) return;
    const ok = await copyText(text);
    showToast(ok ? (all ? 'Page text copied' : 'Copied') : 'Copy is not available', { icon: ok ? 'check' : undefined });
  }, [currentPageIndex]);

  const handleCopyPageText = useCallback(async () => {
    const identity = getEditor().getRenderIdentity();
    if (!identity) return;
    let text = (await getPdfPageText(identity.docHandle, currentPageIndex)).trim();
    if (!text) text = ocrPageText(ocrPagesRef.current[currentPageIndex] ?? []).trim();
    if (!text) {
      showAlert('No Text on This Page', 'This page looks like a scan, so its text is part of the picture. Detect Text recognises it on this device.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Detect Text', onPress: () => handleDetectText() },
      ]);
      return;
    }
    const ok = await copyText(text);
    showToast(ok ? `Copied text of page ${currentPageIndex + 1}` : 'Copy is not available', { icon: ok ? 'check' : undefined });
  }, [getEditor, currentPageIndex, handleDetectText]);

  // More menu
  const handleMoreMenu = useCallback(() => {
    if (isSaving || isExporting) return;
    const dirty = getEditor().isDirty();
    showActionSheet({
      title: displayTitle(documentTitle),
      message: dirty ? 'Unsaved changes are saved before sharing or exporting.' : undefined,
      options: [
        { label: 'Share…', icon: 'share', onPress: () => handleShare() },
        { label: 'Save a Copy…', icon: 'download', onPress: () => handleSaveAs() },
        { label: 'Add Image', icon: 'photo', onPress: () => handleAddImage() },
        {
          label: ocrPagesRef.current[currentPageIndex] ? 'Detect Text Again' : 'Detect Text (Scanned Page)',
          icon: 'scanText',
          onPress: () => handleDetectText(),
        },
        { label: 'Copy Page Text', icon: 'docText', onPress: () => handleCopyPageText() },
        { label: 'Page Overview', icon: 'grid', onPress: () => setPagesVisible(true) },
      ],
    });
  }, [isSaving, isExporting, getEditor, documentTitle, handleShare, handleSaveAs, handleAddImage, handleCopyPageText, handleDetectText, currentPageIndex]);

  // -------------------------------------------------------------------------
  // Leaving the editor (unsaved changes)
  // -------------------------------------------------------------------------

  const promptUnsaved = useCallback(
    (proceed: () => void) => {
      const editor = getEditor();
      showAlert('Unsaved Changes', 'Do you want to save the changes you made to this PDF?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: "Don't Save",
          style: 'destructive',
          onPress: async () => {
            if (typeof editor.discardWorkingChanges === 'function') {
              await editor.discardWorkingChanges().catch(() => {});
            }
            proceed();
          },
        },
        {
          text: 'Save',
          onPress: async () => {
            const saved = await handleSave();
            if (saved) proceed();
          },
        },
      ]);
    },
    [getEditor, handleSave],
  );

  // Back confirmation
  const handleBack = useCallback(() => {
    if (isSaving || isExporting || operationBusy) return;
    if (mode === 'markup') {
      cancelMarkup();
      return;
    }
    if (mode === 'place') {
      cancelPlacement();
      return;
    }
    if (mode === 'search') {
      closeSearch();
      return;
    }
    if (mode === 'textBox') {
      cancelTextBox();
      return;
    }
    if (mode === 'placeText') {
      setMode('view');
      return;
    }
    const editor = getEditor();
    const isDocDirty = editor.isDirty ? editor.isDirty() : pendingCount > 0;
    if (isDocDirty) {
      promptUnsaved(() => navigation.goBack());
    } else {
      navigation.goBack();
    }
  }, [isSaving, isExporting, operationBusy, mode, cancelMarkup, cancelPlacement, cancelTextBox, closeSearch, getEditor, pendingCount, promptUnsaved, navigation]);

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
      promptUnsaved(() => navigation.dispatch(e.data.action));
    });
    return unsubscribe;
  }, [navigation, getEditor, pendingCount, isSaving, promptUnsaved]);

  // Prompt user to pick a PDF document if opened without one
  const handlePickDocument = useCallback(async () => {
    try {
      if (typeof defaultPdfiumEngine.pickPdfDocument !== 'function') {
        showAlert('Not Available', 'Opening PDFs is not available on this device.');
        return;
      }
      const picked = await defaultPdfiumEngine.pickPdfDocument();
      if (!picked) return;
      await openPdfDocument(picked.filePath, picked.fileName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showAlert('Unable to Open PDF', msg);
    }
  }, [openPdfDocument]);

  // -------------------------------------------------------------------------
  // Overlays drawn in page space
  // -------------------------------------------------------------------------

  const renderOverlay = useCallback(
    (ctx: PdfOverlayContext) => {
      const items: InkItem[] = [];
      if (mode === 'view' || mode === 'search') {
        (ocrPages[currentPageIndex] ?? []).forEach((r) => {
          const selected = selectedOcr?.id === r.id;
          items.push({
            key: `ocr_${r.id}`,
            commands: rectCommands({ x: r.rect.x - 1, y: r.rect.y - 1, width: r.rect.width + 2, height: r.rect.height + 2 }),
            color: colors.selection,
            width: 0,
            opacity: selected ? 0.3 : 0.1,
            fill: true,
          });
        });
      }
      if (mode === 'search') {
        searchResults.forEach((r, i) => {
          if (r.pageIndex !== currentPageIndex) return;
          r.rects.forEach((rect, k) => {
            items.push({
              key: `s${i}_${k}`,
              commands: rectCommands({ x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 }),
              color: i === searchIndex ? '#FF9500' : '#FFD60A',
              width: 0,
              opacity: i === searchIndex ? 0.55 : 0.4,
              fill: true,
              multiply: true,
            });
          });
        });
      }
      if (mode === 'markup') {
        drawings.forEach((d) =>
          items.push({ key: d.id, commands: d.commands, color: d.color, width: d.width, opacity: d.opacity, multiply: d.kind === 'highlighter' }),
        );
        if (livePoints.length > 0) {
          const highlighter = markupTool === 'highlighter';
          items.push({
            key: 'live',
            commands: previewCommands(markupTool, livePoints, markupWidth),
            color: markupColor,
            width: highlighter ? markupWidth * HIGHLIGHTER_WIDTH_FACTOR : markupWidth,
            opacity: highlighter ? HIGHLIGHTER_OPACITY : 1,
            multiply: highlighter,
          });
        }
      }
      return (
        <>
          {items.length > 0 && <InkLayer items={items} width={ctx.canvasWidth} height={ctx.canvasHeight} scale={ctx.baseScale} />}
          {mode === 'textBox' && textBox && (() => {
            const k = ctx.baseScale;
            const { draft } = textBox;
            const layout = layoutPdfTextBox(draft);
            const rect = textBoxRect(draft);
            const size = draft.style.fontSize * k;
            return (
              <View
                style={[
                  styles.placementBox,
                  styles.textBoxFrame,
                  {
                    borderColor: colors.primary,
                    left: rect.x * k - 4,
                    top: rect.y * k - 3,
                    width: rect.width * k + 8,
                    height: rect.height * k + 6,
                  },
                ]}>
                {layout.lines.map((line, i) => (
                  <Text
                    key={`tb${i}`}
                    numberOfLines={1}
                    style={[
                      styles.textBoxLine,
                      {
                        left: (line.x - rect.x) * k + 4,
                        // RN draws the ascent above the baseline; place the baseline at y + fontSize
                        top: (line.y - rect.y) * k + 3 - size * 0.07,
                        fontSize: Math.max(size, 1),
                        lineHeight: Math.max(size * 1.15, 1),
                        color: draft.style.color,
                        fontFamily: platformFontFamily(uiFamilyOf(draft.style.fontFamily), Platform.OS),
                        fontWeight: draft.style.isBold ? '700' : '400',
                        fontStyle: draft.style.isItalic ? 'italic' : 'normal',
                      },
                    ]}>
                    {line.text}
                  </Text>
                ))}
                {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
                  <View
                    key={corner}
                    style={[
                      styles.handle,
                      { backgroundColor: colors.primary },
                      corner.includes('t') ? { top: -5 } : { bottom: -5 },
                      corner.includes('l') ? { left: -5 } : { right: -5 },
                    ]}
                  />
                ))}
              </View>
            );
          })()}
          {mode === 'place' && placement && (
            <View
              style={[
                styles.placementBox,
                {
                  borderColor: colors.primary,
                  left: placement.rect.x * ctx.baseScale,
                  top: placement.rect.y * ctx.baseScale,
                  width: placement.rect.width * ctx.baseScale,
                  height: placement.rect.height * ctx.baseScale,
                },
              ]}>
              {placement.kind === 'signature' && placement.signature && (
                <InkLayer
                  items={fitStrokesInto(placement.signature.strokes, {
                    x: 0,
                    y: 0,
                    width: placement.rect.width * ctx.baseScale,
                    height: placement.rect.height * ctx.baseScale,
                  }).map((c, i) => ({
                    key: `sig${i}`,
                    commands: c,
                    color: SIGNATURE_INK,
                    width: Math.max(1, placement.signature!.strokeRatio * placement.rect.height * ctx.baseScale),
                  }))}
                  width={placement.rect.width * ctx.baseScale}
                  height={placement.rect.height * ctx.baseScale}
                />
              )}
              {placement.kind === 'image' && placement.image && (
                <Image source={{ uri: placement.image.uri }} style={StyleSheet.absoluteFill} resizeMode="stretch" />
              )}
              {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
                <View
                  key={corner}
                  style={[
                    styles.handle,
                    { backgroundColor: colors.primary },
                    corner.includes('t') ? { top: -5 } : { bottom: -5 },
                    corner.includes('l') ? { left: -5 } : { right: -5 },
                  ]}
                />
              ))}
            </View>
          )}
        </>
      );
    },
    [mode, searchResults, searchIndex, currentPageIndex, drawings, livePoints, markupTool, markupWidth, markupColor, placement, textBox, colors.primary, colors.selection, ocrPages, selectedOcr],
  );

  // Start of the Add Text panel: the text box being placed, or the last used style
  const modalDraft = useMemo(
    () => (isInsertMode ? (textBox ? { text: textBox.draft.text, style: textBox.draft.style } : { text: '', style: lastTextStyleRef.current }) : null),
    [isInsertMode, textBox],
  );

  const interactionMode: PdfInteractionMode =
    mode === 'markup' ? 'draw' : mode === 'place' || mode === 'textBox' ? 'place' : 'select';

  const annotationColors = settings.annotationColors;
  const editMenuItems: EditMenuItem[] = [
    ...(selectionObjects.length > 0
      ? [{ key: 'edit', label: 'Edit', icon: 'pencil' as const, primary: true, onPress: handleOpenEdit, accessibilityLabel: 'Edit text' }]
      : []),
    { key: 'copy', label: 'Copy', onPress: handleCopySelected, accessibilityLabel: 'Copy text' },
    ...(charMode ? [{ key: 'all', label: 'Select All', onPress: handleSelectAll, accessibilityLabel: 'Select all text on this page' }] : []),
    ...(movableSelection ? [{ key: 'move', label: 'Move', icon: 'hand' as const, onPress: handleMoveSelected, accessibilityLabel: 'Move or resize text' }] : []),
    ...(['highlight', 'underline', 'strikeout'] as const).map((style) => ({
      key: style,
      label: ANNOTATION_STYLE_LABELS[style],
      swatch: annotationColors[style],
      onPress: () => setMarkChooser(style),
      accessibilityLabel: `${ANNOTATION_STYLE_LABELS[style]}: choose a colour`,
    })),
    ...(selectionObjects.length > 0
      ? [{ key: 'delete', label: 'Delete', destructive: true, onPress: handleDeleteSelected, accessibilityLabel: 'Delete text' }]
      : []),
  ];

  // Highlight / Underline / Strikethrough: pick a colour inline, applied right away and remembered
  const markColorChooser: EditMenuColorChooser | null = markChooser
    ? {
        label: ANNOTATION_STYLE_LABELS[markChooser],
        colors: ANNOTATION_SWATCHES[markChooser],
        value: annotationColors[markChooser],
        onBack: () => setMarkChooser(null),
        onPick: (hex) => {
          const style = markChooser;
          appSettings.update({ annotationColors: { ...appSettings.get().annotationColors, [style]: hex } });
          setMarkChooser(null);
          handleMarkSelected(style);
        },
      }
    : null;

  const toolbarItems: ToolbarItem[] = useMemo(
    () => [
      { key: 'undo', icon: 'undo', label: 'Undo', onPress: handleUndo, disabled: !canUndo || isSaving || operationBusy },
      { key: 'redo', icon: 'redo', label: 'Redo', onPress: handleRedo, disabled: !canRedo || isSaving || operationBusy },
      { key: 'text', icon: 'textAdd', label: 'Add Text', onPress: handleStartPlacement, disabled: isSaving || loading },
      { key: 'markup', icon: 'scribble', label: 'Markup', onPress: startMarkup, disabled: isSaving || loading },
      { key: 'sign', icon: 'signature', label: 'Sign', onPress: () => setSignaturesVisible(true), disabled: isSaving || loading },
      { key: 'pages', icon: 'pages', label: 'Pages', onPress: () => setPagesVisible(true), disabled: isSaving || loading },
    ],
    [handleUndo, handleRedo, canUndo, canRedo, isSaving, operationBusy, handleStartPlacement, loading, startMarkup],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Clean empty state if no PDF is loaded
  if (!currentPdfPath && !loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.groupedBackground }]}>
        <NavBar title="PDF" left={<BackButton label="Library" onPress={() => navigation.goBack()} />} />
        <EmptyState
          style={styles.flexCenter}
          icon="docText"
          title="No PDF Selected"
          message="Choose a PDF from your device to view and edit it."
          action={<PillButton label="Choose PDF" icon="folder" onPress={handlePickDocument} large style={{ marginTop: spacing.lg }} />}
        />
      </View>
    );
  }

  // Error Screen
  if (errorMessage && !renderedPage && !loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.groupedBackground }]}>
        <NavBar title="PDF" left={<BackButton label="Library" onPress={() => navigation.goBack()} />} />
        <EmptyState
          style={styles.flexCenter}
          icon={openFailure?.kind === 'password' ? 'lock' : 'info'}
          title={openFailure?.title ?? 'Unable to Open PDF'}
          message={errorMessage}
          action={<PillButton label="Choose Different PDF" icon="folder" onPress={handlePickDocument} large style={{ marginTop: spacing.lg }} />}
        />
      </View>
    );
  }

  const dirty = isDirtyState || pendingCount > 0;
  const title = displayTitle(documentTitle);

  // ---- Top bar per mode
  let topBar: React.ReactNode;
  if (mode === 'search') {
    topBar = (
      <PdfSearchBar
        docHandle={getEditor().getRenderIdentity()?.docHandle ?? null}
        revisionKey={revisionKey}
        activeIndex={searchIndex}
        onResults={(r) => {
          setSearchResults(r);
          setSearchIndex(0);
          const first = r[0];
          if (first && first.pageIndex !== currentPageIndex) loadPage(first.pageIndex);
        }}
        onSelectResult={selectSearchResult}
        onClose={closeSearch}
        collapsed={!searchListVisible}
        onExpand={() => setSearchListVisible((v) => !v)}
        extraSearch={(q) => searchOcrPages(ocrPagesRef.current, q)}
      />
    );
  } else if (mode === 'textBox') {
    topBar = (
      <NavBar
        title={textBox && textBox.replaceIds.length > 0 ? 'Move Text' : 'Place Text'}
        subtitle="Drag to move · pinch to resize"
        left={<BarButton label="Cancel" onPress={cancelTextBox} disabled={operationBusy} />}
        right={<BarButton label="Done" prominent loading={operationBusy} onPress={confirmTextBox} />}
      />
    );
  } else if (mode === 'markup' || mode === 'place') {
    topBar = (
      <NavBar
        title={mode === 'markup' ? 'Markup' : placement?.kind === 'signature' ? 'Place Signature' : 'Place Image'}
        subtitle={mode === 'place' ? 'Drag to move · pinch to resize' : 'Draw with one finger · two fingers to zoom'}
        left={<BarButton label="Cancel" onPress={mode === 'markup' ? cancelMarkup : cancelPlacement} disabled={operationBusy} />}
        right={
          <BarButton
            label="Done"
            prominent
            loading={operationBusy}
            onPress={mode === 'markup' ? finishMarkup : confirmPlacement}
          />
        }
      />
    );
  } else {
    topBar = (
      <NavBar
        title={title}
        subtitle={dirty ? 'Edited' : pageCount > 1 ? `${pageCount} pages` : undefined}
        left={<BackButton label="Library" compact onPress={handleBack} disabled={isSaving || isExporting} />}
        right={
          <>
            <BarButton icon="search" onPress={() => { setSelectedObject(null); setPdfSelection(null); setMode('search'); }} accessibilityLabel="Find in document" disabled={loading} />
            <BarButton icon="moreCircle" onPress={handleMoreMenu} accessibilityLabel="More actions" loading={isExporting} />
            <BarButton label="Save" prominent onPress={handleSave} disabled={!dirty || isSaving || isExporting} loading={isSaving} accessibilityLabel="Save PDF changes" />
          </>
        }
      />
    );
  }

  // ---- Bottom area per mode
  let bottom: React.ReactNode = null;
  if (mode === 'markup') {
    bottom = (
      <MarkupToolbar
        tool={markupTool}
        color={markupColor}
        widthIndex={markupWidthIndex}
        canUndoStroke={drawings.length > 0}
        onToolChange={(t) => {
          setMarkupTool(t);
          if (t === 'highlighter' && !['#FFE066', '#7CF29A', '#7FD4FF', '#FF9ECF', '#FFB37A'].includes(markupColor)) setMarkupColor('#FFE066');
          if (t !== 'highlighter' && ['#FFE066', '#7CF29A', '#7FD4FF', '#FF9ECF', '#FFB37A'].includes(markupColor)) setMarkupColor('#007AFF');
        }}
        onColorChange={setMarkupColor}
        onWidthChange={setMarkupWidthIndex}
        onUndoStroke={() => setDrawings((d) => d.slice(0, -1))}
      />
    );
  } else if (mode === 'place') {
    bottom = <View style={{ height: insets.bottom, backgroundColor: colors.bar }} />;
  } else if (mode === 'textBox' && textBox) {
    const size = textBox.draft.style.fontSize;
    const setSize = (next: number) =>
      setTextBox((current) => {
        if (!current) return current;
        const page = renderedPageRef.current;
        const draft = { ...current.draft, style: { ...current.draft.style, fontSize: Math.max(6, Math.min(96, next)) } };
        return { ...current, draft: page ? clampDraftToPage(draft, { width: page.pageWidth, height: page.pageHeight }) : draft };
      });
    bottom = (
      <Toolbar
        items={[
          { key: 'edit', icon: 'pencil', label: 'Edit Text', onPress: editTextBox, disabled: operationBusy },
          { key: 'smaller', icon: 'minus', label: `${size - 1 >= 6 ? size - 1 : 6} pt`, onPress: () => setSize(size - 1), disabled: operationBusy || size <= 6 },
          { key: 'larger', icon: 'plus', label: `${size + 1 <= 96 ? size + 1 : 96} pt`, onPress: () => setSize(size + 1), disabled: operationBusy || size >= 96 },
        ]}
      />
    );
  } else if (mode === 'search') {
    bottom = null;
  } else {
    bottom = <Toolbar items={toolbarItems} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.canvasBackground }]}>
      {topBar}

      {mode === 'search' && searchListVisible ? (
        <View style={styles.flex}>
          <PdfSearchResultsList results={searchResults} activeIndex={searchIndex} onSelect={selectSearchResult} />
        </View>
      ) : (
        <View
          style={styles.viewportArea}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            if (width > 0 && height > 0) {
              setViewportLayout({ width, height });
            }
          }}>
          {loading && !renderedPage ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Opening…</Text>
            </View>
          ) : (
            <PdfViewport
              page={renderedPage}
              textObjects={textObjects}
              originalTextObjects={originalObjects}
              pendingEdits={pendingEdits}
              selectedObjectId={selectedObject?.id ?? null}
              selectionState={pdfSelection}
              selectionRects={selectionRects}
              selectionHandles={selectionHandles}
              onLongPressDoc={charMode ? handleLongPressDoc : undefined}
              onHandleDrag={handleHandleDrag}
              onSelectObject={handleSelectObject}
              isPlacementMode={isPlacementMode}
              onPlaceTextAt={handlePlaceTextAt}
              viewportWidth={viewportLayout?.width}
              viewportHeight={viewportLayout?.height}
              detailTile={detailTile}
              onViewportSettled={handleViewportSettled}
              interactionMode={interactionMode}
              onDrawStart={onDrawStart}
              onDrawMove={onDrawMove}
              onDrawEnd={onDrawEnd}
              onPlacementGesture={mode === 'textBox' ? onTextBoxGesture : onPlacementGesture}
              onSwipePage={pageCount > 1 ? handleSwipePage : undefined}
              renderOverlay={renderOverlay}
              onTapPoint={handleTapPoint}
            />
          )}

          {/* Hint pill for text placement */}
          {mode === 'placeText' && (
            <HintPill text="Tap where the text should go" actionLabel="Cancel" onAction={() => setMode('view')} />
          )}

          {/* Page indicator (tap for page overview) */}
          {mode !== 'markup' && mode !== 'place' && pageCount > 1 && !selectedObject && !selectedOcr && (
            <Pressable
              onPress={() => setPagesVisible(true)}
              accessibilityRole="button"
              accessibilityLabel={`Page ${currentPageIndex + 1} of ${pageCount}. Open page overview`}
              style={[styles.pagePill, { backgroundColor: colors.hud }]}>
              <Pressable onPress={() => goToPage(currentPageIndex - 1)} disabled={currentPageIndex === 0} hitSlop={8} accessibilityLabel="Previous page">
                <Icon name="chevronLeft" size={16} color={currentPageIndex === 0 ? 'rgba(255,255,255,0.3)' : colors.onHud} weight={2.4} />
              </Pressable>
              <Text style={[styles.pagePillText, { color: colors.onHud }]}>
                {currentPageIndex + 1} of {pageCount}
              </Text>
              <Pressable onPress={() => goToPage(currentPageIndex + 1)} disabled={currentPageIndex >= pageCount - 1} hitSlop={8} accessibilityLabel="Next page">
                <Icon name="chevronRight" size={16} color={currentPageIndex >= pageCount - 1 ? 'rgba(255,255,255,0.3)' : colors.onHud} weight={2.4} />
              </Pressable>
            </Pressable>
          )}

          {/* First use: how to select text */}
          {charMode && !hasSelection && !settingsTipSeen && !editModalVisible && mode === 'view' && !loading && (
            <HintPill
              text="Long-press text to select it, then drag the handles"
              actionLabel="OK"
              onAction={() => appSettings.update({ pdfSelectionTipSeen: true })}
            />
          )}

          {/* Scanned page: offer on-device text recognition */}
          {mode === 'view' && !loading && renderedPage && !hasSelection && !selectedOcr && !ocrPages[currentPageIndex] &&
            !scanHintDismissed && isLikelyScannedPage(textObjects) && !busyLabel && (
              <HintPill
                icon="scanText"
                text="Scanned page — its text is part of the picture"
                actionLabel="Detect Text"
                onAction={() => {
                  setScanHintDismissed(true);
                  handleDetectText();
                }}
              />
            )}

          {/* Edit menu for recognised (scanned) text */}
          {selectedOcr && !editModalVisible && mode === 'view' && (
            <EditMenu
              items={[
                { key: 'edit', label: 'Edit', icon: 'pencil', primary: true, onPress: handleEditOcr, accessibilityLabel: 'Replace recognised text' },
                { key: 'copy', label: 'Copy', onPress: () => handleCopyOcr(false), accessibilityLabel: 'Copy recognised text' },
                { key: 'copyAll', label: 'Copy Page', onPress: () => handleCopyOcr(true), accessibilityLabel: 'Copy all recognised text on this page' },
                { key: 'delete', label: 'Delete', destructive: true, onPress: handleDeleteOcr, accessibilityLabel: 'Remove recognised text' },
              ]}
              preview={selectedOcr.text}
              disabled={operationBusy}
              onClose={() => setSelectedOcr(null)}
            />
          )}

          {/* iOS edit menu for the selected text */}
          {hasSelection && !editModalVisible && mode === 'view' && (
            <EditMenu
              items={editMenuItems}
              preview={selectedText}
              disabled={operationBusy}
              colorChooser={markColorChooser}
              onClose={() => handleSelectObject(null)}
            />
          )}

          {/* Blocking activity indicator for native work */}
          {busyLabel && (
            <View style={styles.busyOverlay} pointerEvents="auto">
              <View style={[styles.busyCard, { backgroundColor: colors.hud }]}>
                <ActivityIndicator color={colors.onHud} />
                <Text style={[styles.busyText, { color: colors.onHud }]}>{busyLabel}</Text>
              </View>
            </View>
          )}
        </View>
      )}

      {bottom}

      {/* Text Editing & Formatting Modal */}
      <PdfTextEditModal
        visible={editModalVisible}
        targetObject={charRange ? selectionObjects[0] ?? null : selectedObject}
        initialText={charRange ? selectedText.replace(/\s*\n\s*/g, ' ') : null}
        formatLockedReason={
          charRange && !wholeObjectsSelected
            ? 'Only the text changes when part of a word is selected. Select whole words to change the font, size or colour.'
            : null
        }
        isInsertMode={isInsertMode}
        draft={modalDraft}
        onApply={handleApplyModalText}
        onCancel={() => {
          setEditModalVisible(false);
          setIsInsertMode(false);
        }}
      />

      <PdfPagesSheet
        visible={pagesVisible}
        onClose={() => setPagesVisible(false)}
        docHandle={getEditor().getRenderIdentity()?.docHandle ?? null}
        revisionKey={revisionKey}
        pageCount={pageCount}
        currentPage={currentPageIndex}
        busy={operationBusy}
        onGoToPage={(i) => loadPage(i)}
        onApply={(op, description) => {
          const next =
            op.type === 'deletePage'
              ? Math.max(0, Math.min(currentPageIndex, pageCount - 2))
              : op.type === 'movePage' && op.pageIndex === currentPageIndex
                ? op.toIndex
                : currentPageIndex;
          return applyOperations([op], description, next);
        }}
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
  flexCenter: { flex: 1 },
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
  pagePill: {
    position: 'absolute',
    bottom: spacing.md,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
  },
  pagePillText: { ...typography.footnote, fontWeight: fontWeights.semibold, minWidth: 52, textAlign: 'center' },
  busyOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  busyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg + 2, paddingVertical: spacing.md - 1, borderRadius: 14 },
  busyText: { ...typography.subhead, fontWeight: fontWeights.medium },
  placementBox: { position: 'absolute', borderWidth: 1.5, borderStyle: 'dashed' },
  textBoxFrame: { borderRadius: 3 },
  textBoxLine: { position: 'absolute', includeFontPadding: false },
  handle: { position: 'absolute', width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: '#FFFFFF' },
});
