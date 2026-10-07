import React, { useCallback, useEffect, useRef } from 'react';
import {
  Dimensions,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import {
  PdfRect,
  PdfRenderedPage,
  PdfTextObject,
  PdfSelectionState,
  PdfTextEditCommand,
  PdfInsertCommand,
  PdfReplaceCommand,
} from '../types';
import { documentToScreenRect, hitTestTextObjects, pdfTapToleranceDocPoints } from '../pdfiumEngine';
import { viewportPointToDocumentPoint, visibleDocumentRect } from '../pdfViewportMath';
import { useTheme } from '../../../ui/ThemeProvider';

/** How one-finger gestures on the page behave. */
export type PdfInteractionMode = 'select' | 'draw' | 'place';

export const PDF_MIN_ZOOM = 1;
export const PDF_MAX_ZOOM = 6;
/** Horizontal swipe (at fit zoom) that changes the page. */
export const PAGE_SWIPE_DISTANCE = 72;

export interface PdfOverlayContext {
  /** Screen points per page point at zoom 1 (page content is laid out at this scale). */
  readonly baseScale: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Current zoom (updated when gestures settle). */
  readonly zoom: number;
}

export interface PdfPlacementGesture {
  readonly phase: 'start' | 'update' | 'end';
  /** Translation in page points since the gesture started. */
  readonly dx: number;
  readonly dy: number;
  /** Scale since the gesture started (pinch), 1 for drags. */
  readonly scale: number;
}

interface PdfViewportProps {
  page: PdfRenderedPage | null;
  textObjects: PdfTextObject[];
  originalTextObjects?: PdfTextObject[];
  pendingEdits?: readonly PdfTextEditCommand[];
  selectedObjectId?: string | null;
  selectionState?: PdfSelectionState | null;
  /**
   * Document-space rectangles of the current selection (one band per selected line). When
   * omitted, the selected object's bounds are used.
   */
  selectionRects?: readonly PdfRect[] | null;
  onSelectObject: (obj: PdfTextObject | null) => void;
  isPlacementMode?: boolean;
  onPlaceTextAt?: (point: { x: number; y: number }) => void;
  viewportWidth?: number;
  viewportHeight?: number;
  /**
   * Sharper render of part of the page (zoom detail), drawn over the base render at its
   * document-space rect. Ignored when it belongs to another page.
   */
  detailTile?: PdfDetailTile | null;
  /**
   * Called once a pinch or pan has ended (never per frame) with the zoom, the visible part
   * of the page in document points and the fit scale, so the screen can decide whether the
   * visible region needs a sharper render.
   */
  onViewportSettled?: (state: PdfViewportSettledState) => void;
  /** 'draw': one finger draws (two fingers zoom); 'place': gestures move/scale a placement. */
  interactionMode?: PdfInteractionMode;
  onDrawStart?: (point: { x: number; y: number }) => void;
  onDrawMove?: (point: { x: number; y: number }) => void;
  onDrawEnd?: () => void;
  onPlacementGesture?: (gesture: PdfPlacementGesture) => void;
  /** Swipe left (+1) / right (-1) at fit zoom. */
  onSwipePage?: (direction: 1 | -1) => void;
  /** Extra layers drawn in page space (search highlights, ink preview, placement box). */
  renderOverlay?: (ctx: PdfOverlayContext) => React.ReactNode;
  /**
   * Character-level selection (Drive-style). When set, a single tap only clears the selection
   * (onSelectObject(null)), a long press reports the document point, and a pan that starts on a
   * selection handle drags that handle instead of moving the page.
   */
  onLongPressDoc?: (point: { x: number; y: number }) => void;
  /** Selection handle anchors in document points (caret x and line top/bottom). */
  selectionHandles?: PdfSelectionHandles | null;
  onHandleDrag?: (which: 'start' | 'end', point: { x: number; y: number }, phase: 'start' | 'move' | 'end') => void;
  /**
   * Called first for a tap on the page in select mode with the page point and the finger
   * tolerance in points (e.g. recognised text on scanned pages). Return true when handled.
   */
  onTapPoint?: (point: { x: number; y: number }, tolerance: number) => boolean;
}

export interface PdfSelectionHandle {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}

export interface PdfSelectionHandles {
  readonly start: PdfSelectionHandle;
  readonly end: PdfSelectionHandle;
}

/** Touch radius (screen points) around a handle that grabs it. */
export const PDF_HANDLE_GRAB_PT = 28;

export interface PdfDetailTile {
  readonly uri: string;
  readonly pageIndex: number;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface PdfViewportSettledState {
  readonly zoom: number;
  readonly baseFitScale: number;
  readonly visibleRect: { x: number; y: number; width: number; height: number } | null;
}

export const PdfViewport: React.FC<PdfViewportProps> = ({
  page,
  textObjects,
  originalTextObjects = [],
  pendingEdits = [],
  selectedObjectId,
  selectionState,
  selectionRects = null,
  onSelectObject,
  isPlacementMode = false,
  onPlaceTextAt,
  viewportWidth = Dimensions.get('window').width,
  viewportHeight = Dimensions.get('window').height * 0.7,
  detailTile = null,
  onViewportSettled,
  interactionMode = 'select',
  onDrawStart,
  onDrawMove,
  onDrawEnd,
  onPlacementGesture,
  onSwipePage,
  renderOverlay,
  onLongPressDoc,
  selectionHandles = null,
  onHandleDrag,
  onTapPoint,
}) => {
  const { colors, dark } = useTheme();

  // Shared values for smooth 60fps GPU pan & pinch zoom on UI thread
  const scale = useSharedValue(1.0);
  const savedScale = useSharedValue(1.0);
  const translateX = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  // Keep JS-accessible mirror of transform for tap hit-testing
  const transformRef = useRef({ scale: 1.0, translateX: 0, translateY: 0 });
  const [zoomMirror, setZoomMirror] = React.useState(1);

  const updateTransformMirror = useCallback(
    (s: number, tx: number, ty: number) => {
      transformRef.current = { scale: s, translateX: tx, translateY: ty };
      setZoomMirror(s);
    },
    [],
  );

  // Fit calculation: scale page to fit both width and height with 24px padding
  const fitPadding = 24;
  const availW = Math.max(viewportWidth - fitPadding, 100);
  const availH = Math.max(viewportHeight - fitPadding, 100);

  const scaleX = page && page.pageWidth > 0 ? availW / page.pageWidth : 1.0;
  const scaleY = page && page.pageHeight > 0 ? availH / page.pageHeight : 1.0;
  const baseScale = Math.min(scaleX, scaleY);

  const canvasWidth = page ? page.pageWidth * baseScale : viewportWidth;
  const canvasHeight = page ? page.pageHeight * baseScale : viewportHeight;
  const pageOriginX = (viewportWidth - canvasWidth) / 2;
  const pageOriginY = (viewportHeight - canvasHeight) / 2;

  // A different page always starts at fit (iOS behaviour).
  const pageIndexKey = page ? `${page.pageIndex}` : '';
  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    transformRef.current = { scale: 1, translateX: 0, translateY: 0 };
    setZoomMirror(1);
  }, [pageIndexKey, scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

  /** Viewport point -> page point using the JS transform mirror. */
  const toDocPoint = useCallback(
    (vx: number, vy: number) => {
      const { scale: s, translateX: tx, translateY: ty } = transformRef.current;
      return viewportPointToDocumentPoint(
        { x: vx, y: vy },
        { baseScale, pageOriginX, pageOriginY, zoom: s, translateX: tx, translateY: ty },
      );
    },
    [baseScale, pageOriginX, pageOriginY],
  );

  // Keep stable ref to handleTapDoc so RNGH worklet never calls a stale closure
  const handleTapDocRef = useRef<(vx: number, vy: number) => void>(() => {});

  const onExecuteTap = useCallback((vx: number, vy: number) => {
    handleTapDocRef.current(vx, vy);
  }, []);

  const lastLogTimeRef = useRef(0);
  const logGestureEvent = useCallback((event: string, details?: string) => {
    console.log('[PHASE2_GESTURE] ' + event + (details ? ' ' + details : ''));
  }, []);

  const logThrottledUpdate = useCallback((gesture: 'PINCH' | 'PAN', details: string) => {
    const now = Date.now();
    if (now - lastLogTimeRef.current > 300) {
      lastLogTimeRef.current = now;
      console.log('[PHASE2_GESTURE] ' + gesture + '_UPDATE ' + details);
    }
  }, []);

  // Build original objects map for knockout patches
  const origMap = useRef(new Map<string, PdfTextObject>());
  origMap.current.clear();
  for (const obj of originalTextObjects) {
    origMap.current.set(obj.id, obj);
  }

  // Single Tap: hit-test text object or handle text placement
  const handleTapDoc = useCallback(
    (viewportX: number, viewportY: number) => {
      if (!page || interactionMode !== 'select') return;
      const { scale: curScale } = transformRef.current;
      const point = toDocPoint(viewportX, viewportY);

      console.log('[PHASE3_PDF] TAP point=(' + Math.round(viewportX) + ',' + Math.round(viewportY) + ')');
      console.log('[PHASE3_PDF] TAP_DOCUMENT_POINT point=(' + Math.round(point.x) + ',' + Math.round(point.y) + ') page=' + page.pageIndex);

      if (
        point.x < 0 ||
        point.y < 0 ||
        point.x > page.pageWidth ||
        point.y > page.pageHeight
      ) {
        console.log('[PHASE3_PDF] NO_HIT');
        console.log('[PHASE3_PDF] SELECTION_CHANGED selectedId=null');
        if (!isPlacementMode) {
          onSelectObject(null);
        } else {
          const clampedX = Math.max(16, Math.min(page.pageWidth - 16, Math.max(0, point.x)));
          const clampedY = Math.max(16, Math.min(page.pageHeight - 16, Math.max(0, point.y)));
          onPlaceTextAt?.({ x: Math.round(clampedX), y: Math.round(clampedY) });
        }
        return;
      }

      // In Placement Mode: trigger text insertion at exact tapped location
      if (isPlacementMode) {
        onPlaceTextAt?.({ x: Math.round(point.x), y: Math.round(point.y) });
        return;
      }

      // Screen-provided targets (recognised text on scanned pages) come first
      if (onTapPoint && onTapPoint(point, pdfTapToleranceDocPoints(baseScale, curScale))) {
        return;
      }

      // Character-level selection: a single tap never selects; it clears the selection
      if (onLongPressDoc) {
        onSelectObject(null);
        return;
      }

      // Hit-test vector text objects in document coordinates (with generous touch tolerance)
      console.log('[PHASE3_PDF] HIT_TEST_START candidates=' + textObjects.length);
      // Finger-sized target on screen at every zoom (nearest text within ~20 pt of the tap)
      const tolerance = pdfTapToleranceDocPoints(baseScale, curScale);
      const hit = hitTestTextObjects(textObjects, point, tolerance);
      if (hit) {
        const preview = (hit.text || '').replace(/\s+/g, ' ');
        console.log('[PHASE3_PDF] HIT_OBJECT id=' + hit.id + ' text="' + preview + '" bounds=(' + Math.round(hit.bounds.x) + ',' + Math.round(hit.bounds.y) + ',' + Math.round(hit.bounds.width) + ',' + Math.round(hit.bounds.height) + ')');
      } else {
        console.log('[PHASE3_PDF] NO_HIT');
      }
      console.log('[PHASE3_PDF] SELECTION_CHANGED selectedId=' + (hit ? hit.id : 'null'));
      onSelectObject(hit);
    },
    [
      page,
      baseScale,
      interactionMode,
      toDocPoint,
      isPlacementMode,
      onPlaceTextAt,
      textObjects,
      onSelectObject,
      onLongPressDoc,
      onTapPoint,
    ],
  );

  handleTapDocRef.current = handleTapDoc;

  // Gesture settled: report zoom + visible document rect (latest values via ref)
  const settledRef = useRef<(s: number, tx: number, ty: number) => void>(() => {});
  settledRef.current = (s: number, tx: number, ty: number) => {
    if (!page || !onViewportSettled) return;
    onViewportSettled({
      zoom: s,
      baseFitScale: baseScale,
      visibleRect: visibleDocumentRect(
        { width: viewportWidth, height: viewportHeight },
        { baseScale, pageOriginX, pageOriginY, zoom: s, translateX: tx, translateY: ty },
        { width: page.pageWidth, height: page.pageHeight },
      ),
    });
  };
  const notifySettled = useCallback((s: number, tx: number, ty: number) => {
    settledRef.current(s, tx, ty);
  }, []);

  // Draw / placement / swipe callbacks through refs (worklets call stable functions)
  const drawRef = useRef({ start: onDrawStart, move: onDrawMove, end: onDrawEnd, place: onPlacementGesture, swipe: onSwipePage });
  drawRef.current = { start: onDrawStart, move: onDrawMove, end: onDrawEnd, place: onPlacementGesture, swipe: onSwipePage };
  const jsDrawStart = useCallback((vx: number, vy: number) => drawRef.current.start?.(toDocPoint(vx, vy)), [toDocPoint]);
  const jsDrawMove = useCallback((vx: number, vy: number) => drawRef.current.move?.(toDocPoint(vx, vy)), [toDocPoint]);
  const jsDrawEnd = useCallback(() => drawRef.current.end?.(), []);
  const jsPlacement = useCallback(
    (phase: 'start' | 'update' | 'end', tx: number, ty: number, s: number) => {
      const k = baseScale * transformRef.current.scale;
      drawRef.current.place?.({ phase, dx: tx / k, dy: ty / k, scale: s });
    },
    [baseScale],
  );
  const jsSwipe = useCallback((direction: number) => drawRef.current.swipe?.(direction > 0 ? 1 : -1), []);

  // Character selection bridges (latest callbacks through a ref)
  const selectionRef = useRef({ longPress: onLongPressDoc, handle: onHandleDrag });
  selectionRef.current = { longPress: onLongPressDoc, handle: onHandleDrag };
  const charMode = !!onLongPressDoc;
  const jsLongPress = useCallback(
    (vx: number, vy: number) => {
      if (!page) return;
      const p = toDocPoint(vx, vy);
      if (p.x < -8 || p.y < -8 || p.x > page.pageWidth + 8 || p.y > page.pageHeight + 8) return;
      selectionRef.current.longPress?.(p);
    },
    [page, toDocPoint],
  );
  const jsHandle = useCallback(
    (which: number, vx: number, vy: number, phase: number) => {
      selectionRef.current.handle?.(
        which === 1 ? 'start' : 'end',
        toDocPoint(vx, vy),
        phase === 0 ? 'start' : phase === 1 ? 'move' : 'end',
      );
    },
    [toDocPoint],
  );

  // Handle anchors for the UI thread: [startX, startTop, startBottom, endX, endTop, endBottom]
  const handlesSV = useSharedValue<number[]>([]);
  const draggingHandle = useSharedValue(0); // 0 none, 1 start, 2 end
  useEffect(() => {
    handlesSV.value = selectionHandles
      ? [
          selectionHandles.start.x, selectionHandles.start.top, selectionHandles.start.bottom,
          selectionHandles.end.x, selectionHandles.end.top, selectionHandles.end.bottom,
        ]
      : [];
  }, [selectionHandles, handlesSV]);

  const mode = interactionMode;
  const canSwipe = !!onSwipePage;

  /** Animates back to fit (zoom 1, centred). */
  const snapToFit = () => {
    'worklet';
    scale.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) });
    translateX.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.cubic) });
    translateY.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.cubic) });
    savedScale.value = 1;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  };

  // Two-finger pinch with focal point tracking. In placement mode it scales the placement.
  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      'worklet';
      if (mode === 'place') {
        runOnJS(jsPlacement)('start', 0, 0, 1);
        return;
      }
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(logGestureEvent)('PINCH_START', 'scale=' + Math.round(scale.value * 100) / 100);
    })
    .onUpdate((e) => {
      'worklet';
      if (mode === 'place') {
        runOnJS(jsPlacement)('update', 0, 0, e.scale);
        return;
      }
      // Rubber-band slightly below fit; snaps back on release.
      const nextScale = Math.min(Math.max(savedScale.value * e.scale, PDF_MIN_ZOOM * 0.75), PDF_MAX_ZOOM);
      const scaleRatio = nextScale / savedScale.value;
      // Keep point under fingers pinned
      const focalX = e.focalX - pageOriginX;
      const focalY = e.focalY - pageOriginY;
      translateX.value = focalX - (focalX - savedTranslateX.value) * scaleRatio;
      translateY.value = focalY - (focalY - savedTranslateY.value) * scaleRatio;
      scale.value = nextScale;
      runOnJS(logThrottledUpdate)('PINCH', 'scale=' + Math.round(nextScale * 100) / 100);
    })
    .onEnd((e) => {
      'worklet';
      if (mode === 'place') {
        runOnJS(jsPlacement)('end', 0, 0, e.scale);
        return;
      }
      if (scale.value <= PDF_MIN_ZOOM + 0.02) {
        snapToFit();
        runOnJS(updateTransformMirror)(1, 0, 0);
        runOnJS(notifySettled)(1, 0, 0);
      } else {
        savedScale.value = scale.value;
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        runOnJS(updateTransformMirror)(scale.value, translateX.value, translateY.value);
        runOnJS(notifySettled)(scale.value, translateX.value, translateY.value);
      }
      runOnJS(logGestureEvent)('PINCH_END', 'scale=' + Math.round(scale.value * 100) / 100);
    });

  // Pan: moves the page (select), draws (draw, one finger) or moves the placement (place).
  // Which handle (1 start, 2 end, 0 none) a touch at viewport (vx, vy) grabs
  const handleAt = (vx: number, vy: number): number => {
    'worklet';
    const h = handlesSV.value;
    if (h.length !== 6) return 0;
    const k = baseScale * scale.value;
    const ox = pageOriginX + translateX.value;
    const oy = pageOriginY + translateY.value;
    // start knob sits above the caret top, end knob below the caret bottom
    const sx = ox + h[0] * k, sTop = oy + h[1] * k, sBottom = oy + h[2] * k;
    const ex = ox + h[3] * k, eTop = oy + h[4] * k, eBottom = oy + h[5] * k;
    const dist = (x: number, y: number, cx: number, top: number, bottom: number) => {
      const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
      const dx = x - cx;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const ds = dist(vx, vy, sx, sTop - 14, sBottom);
    const de = dist(vx, vy, ex, eTop, eBottom + 14);
    if (ds > PDF_HANDLE_GRAB_PT && de > PDF_HANDLE_GRAB_PT) return 0;
    return ds <= de ? 1 : 2;
  };

  const longPressGesture = Gesture.LongPress()
    .enabled(mode === 'select' && charMode)
    .minDuration(380)
    .maxDistance(10)
    .onStart((e) => {
      'worklet';
      runOnJS(jsLongPress)(e.x, e.y);
    });

  const panGesture = Gesture.Pan()
    .minDistance(mode === 'draw' ? 0 : 10)
    .minPointers(1)
    .maxPointers(mode === 'select' ? 2 : 1)
    .onStart((e) => {
      'worklet';
      if (mode === 'draw') {
        runOnJS(jsDrawStart)(e.x, e.y);
        return;
      }
      if (mode === 'place') {
        runOnJS(jsPlacement)('start', 0, 0, 1);
        return;
      }
      if (charMode) {
        const which = handleAt(e.x - e.translationX, e.y - e.translationY);
        if (which !== 0) {
          draggingHandle.value = which;
          runOnJS(jsHandle)(which, e.x, e.y, 0);
          return;
        }
      }
      draggingHandle.value = 0;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(logGestureEvent)('PAN_START', 'tx=' + Math.round(translateX.value) + ' ty=' + Math.round(translateY.value));
    })
    .onUpdate((e) => {
      'worklet';
      if (mode === 'draw') {
        runOnJS(jsDrawMove)(e.x, e.y);
        return;
      }
      if (mode === 'place') {
        runOnJS(jsPlacement)('update', e.translationX, e.translationY, 1);
        return;
      }
      if (draggingHandle.value !== 0) {
        runOnJS(jsHandle)(draggingHandle.value, e.x, e.y, 1);
        return;
      }
      const atFit = scale.value <= PDF_MIN_ZOOM + 0.02;
      const curTx = savedTranslateX.value + e.translationX;
      // At fit the page only follows horizontal swipes (page change feedback).
      const curTy = atFit ? 0 : savedTranslateY.value + e.translationY;
      translateX.value = atFit && canSwipe ? curTx * 0.6 : curTx;
      translateY.value = curTy;
      runOnJS(logThrottledUpdate)('PAN', 'tx=' + Math.round(curTx) + ' ty=' + Math.round(curTy));
    })
    .onEnd((e) => {
      'worklet';
      if (mode === 'draw') {
        runOnJS(jsDrawEnd)();
        return;
      }
      if (mode === 'place') {
        runOnJS(jsPlacement)('end', e.translationX, e.translationY, 1);
        return;
      }
      if (draggingHandle.value !== 0) {
        const which = draggingHandle.value;
        draggingHandle.value = 0;
        runOnJS(jsHandle)(which, e.x, e.y, 2);
        return;
      }
      const atFit = scale.value <= PDF_MIN_ZOOM + 0.02;
      if (atFit) {
        if (canSwipe && Math.abs(e.translationX) > PAGE_SWIPE_DISTANCE && Math.abs(e.translationX) > Math.abs(e.translationY)) {
          runOnJS(jsSwipe)(e.translationX < 0 ? 1 : -1);
        }
        snapToFit();
        runOnJS(updateTransformMirror)(1, 0, 0);
        runOnJS(notifySettled)(1, 0, 0);
      } else {
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        runOnJS(updateTransformMirror)(scale.value, translateX.value, translateY.value);
        runOnJS(notifySettled)(scale.value, translateX.value, translateY.value);
      }
      runOnJS(logGestureEvent)('PAN_END', 'tx=' + Math.round(translateX.value) + ' ty=' + Math.round(translateY.value));
    });

  // Double tap: zoom to 2.5x around the tap, or back to fit.
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(260)
    .maxDistance(24)
    .enabled(mode === 'select')
    .onEnd((e, success) => {
      'worklet';
      if (!success) return;
      if (scale.value > PDF_MIN_ZOOM + 0.05) {
        snapToFit();
        runOnJS(updateTransformMirror)(1, 0, 0);
        runOnJS(notifySettled)(1, 0, 0);
        return;
      }
      const target = 2.5;
      const fx = e.x - pageOriginX;
      const fy = e.y - pageOriginY;
      const tx = fx - fx * target;
      const ty = fy - fy * target;
      scale.value = withTiming(target, { duration: 240, easing: Easing.out(Easing.cubic) });
      translateX.value = withTiming(tx, { duration: 240, easing: Easing.out(Easing.cubic) });
      translateY.value = withTiming(ty, { duration: 240, easing: Easing.out(Easing.cubic) });
      savedScale.value = target;
      savedTranslateX.value = tx;
      savedTranslateY.value = ty;
      runOnJS(updateTransformMirror)(target, tx, ty);
      runOnJS(notifySettled)(target, tx, ty);
    });

  // Tap Gesture: comfortable physical touch duration and movement tolerance
  const tapGesture = Gesture.Tap()
    .enabled(mode === 'select')
    .maxDuration(400)
    .maxDistance(16)
    .onEnd((e, success) => {
      'worklet';
      if (success) {
        runOnJS(onExecuteTap)(e.x, e.y);
      }
    });

  // Double tap wins over single tap; deliberate drag engages pan; pinch runs simultaneously
  const composedGestures = Gesture.Simultaneous(
    pinchGesture,
    Gesture.Exclusive(doubleTapGesture, longPressGesture, tapGesture, panGesture),
  );

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transformOrigin: 'top left',
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { scale: scale.value },
      ],
    };
  });

  // Find currently selected object / bounds (supports selectionState or selectedObjectId)
  const activeSelectedId = selectionState?.selectedObjectId ?? selectedObjectId ?? null;
  const selectedObject = activeSelectedId
    ? textObjects.find((o) => o.id === activeSelectedId) || null
    : null;

  const activeDocBounds = selectionState?.selectedBounds ?? selectedObject?.bounds ?? null;
  const selectedDocRects: readonly PdfRect[] =
    selectionRects && selectionRects.length > 0 ? selectionRects : activeDocBounds ? [activeDocBounds] : [];
  // Padding around the glyph box: ~1.5 screen points at every zoom
  const selectionPad = 1.5 / Math.max(zoomMirror, 1);

  // Filter pending edits for current visible page
  const pageIndex = page?.pageIndex ?? 0;
  const currentPendingEdits = pendingEdits.filter(
    (cmd) => cmd.pageIndex === pageIndex,
  );

  return (
    <GestureDetector gesture={composedGestures}>
      <View
        style={[
          styles.viewportContainer,
          { width: viewportWidth, height: viewportHeight, backgroundColor: colors.canvasBackground },
        ]}>
        <Animated.View
          style={[
            styles.canvasWrapper,
            {
              position: 'absolute',
              left: pageOriginX,
              top: pageOriginY,
              shadowOpacity: dark ? 0.5 : 0.14,
            },
            animatedStyle,
          ]}>
          {page && (
            <View style={{ width: canvasWidth, height: canvasHeight, position: 'relative' }}>
              {/* 1. Base High-res Rendered PDF page bitmap */}
              <Image
                source={{ uri: page.uri }}
                style={{ width: canvasWidth, height: canvasHeight }}
                resizeMode="contain"
              />

              {/* 1b. Zoom detail: sharper render of the visible region, same document rect */}
              {detailTile && detailTile.pageIndex === page.pageIndex && (
                <Image
                  source={{ uri: detailTile.uri }}
                  resizeMode="stretch"
                  style={{
                    position: 'absolute',
                    left: detailTile.rect.x * baseScale,
                    top: detailTile.rect.y * baseScale,
                    width: detailTile.rect.width * baseScale,
                    height: detailTile.rect.height * baseScale,
                  }}
                />
              )}

              {/* 2. Knockout Patches Layer (Covers original raster text for replaced or deleted objects) */}
              {currentPendingEdits.map((cmd) => {
                if (cmd.type !== 'replace' && cmd.type !== 'delete') return null;
                const orig = origMap.current.get(cmd.objectId);
                if (!orig) return null;
                const patchRect = documentToScreenRect(orig.bounds, baseScale, baseScale);

                return (
                  <View
                    key={`patch-${cmd.objectId}`}
                    pointerEvents="none"
                    style={[
                      styles.knockoutPatch,
                      {
                        left: patchRect.x - 1,
                        top: patchRect.y - 1,
                        width: Math.max(patchRect.width + 2, 8),
                        height: Math.max(patchRect.height + 2, 10),
                      },
                    ]}
                  />
                );
              })}

              {/* 3. Live Optimistic Text Layer (Displays newly inserted or replaced text immediately) */}
              {currentPendingEdits.map((cmd) => {
                if (cmd.type === 'replace') {
                  const replaceCmd = cmd as PdfReplaceCommand;
                  const orig = origMap.current.get(replaceCmd.objectId);
                  if (!orig) return null;
                  const textRect = documentToScreenRect(orig.bounds, baseScale, baseScale);
                  const effectiveFontSize =
                    (replaceCmd.format?.fontSize ?? orig.fontSize ?? 14) * baseScale;
                  const effectiveColor = replaceCmd.format?.color ?? orig.color ?? '#000000';
                  const isBold = replaceCmd.format?.isBold ?? false;
                  const isItalic = replaceCmd.format?.isItalic ?? false;

                  return (
                    <Text
                      key={`live-rep-${replaceCmd.objectId}`}
                      pointerEvents="none"
                      style={[
                        styles.liveText,
                        {
                          left: textRect.x,
                          top: textRect.y,
                          fontSize: Math.max(effectiveFontSize, 6),
                          color: effectiveColor,
                          fontWeight: isBold ? '700' : '400',
                          fontStyle: isItalic ? 'italic' : 'normal',
                        },
                      ]}>
                      {replaceCmd.newText}
                    </Text>
                  );
                }

                if (cmd.type === 'insert') {
                  const insCmd = cmd as PdfInsertCommand;
                  const textRect = documentToScreenRect(insCmd.bounds, baseScale, baseScale);
                  const effectiveFontSize = (insCmd.fontSize ?? 14) * baseScale;
                  const effectiveColor = insCmd.color ?? '#000000';
                  const fontLower = (insCmd.fontName || '').toLowerCase();
                  const isBold = fontLower.includes('bold');
                  const isItalic = fontLower.includes('oblique') || fontLower.includes('italic');

                  return (
                    <Text
                      key={`live-ins-${insCmd.objectId}`}
                      pointerEvents="none"
                      style={[
                        styles.liveText,
                        {
                          left: textRect.x,
                          top: textRect.y,
                          fontSize: Math.max(effectiveFontSize, 6),
                          color: effectiveColor,
                          fontWeight: isBold ? '700' : '400',
                          fontStyle: isItalic ? 'italic' : 'normal',
                        },
                      ]}>
                      {insCmd.text}
                    </Text>
                  );
                }

                return null;
              })}

              {/* 4. Selection: a subtle tinted band over each selected line (iOS text selection) */}
              {selectedDocRects.map((rect, i) => {
                const r = documentToScreenRect(rect, baseScale, baseScale);
                return (
                  <View
                    key={`sel-${i}`}
                    pointerEvents="none"
                    style={[
                      styles.selectedHighlight,
                      {
                        backgroundColor: colors.selection,
                        left: r.x - selectionPad,
                        top: r.y - selectionPad,
                        width: Math.max(r.width + selectionPad * 2, 6),
                        height: Math.max(r.height + selectionPad * 2, 8),
                      },
                    ]}
                  />
                );
              })}

              {/* 4b. Selection handles: caret + knob, constant size on screen */}
              {selectionHandles && (['start', 'end'] as const).map((which) => {
                const h = selectionHandles[which];
                const k = baseScale;
                const z = Math.max(zoomMirror, 1);
                const knob = 11 / z;
                const caretW = 2 / z;
                const top = h.top * k;
                const bottom = h.bottom * k;
                return (
                  <View key={`handle-${which}`} pointerEvents="none" style={StyleSheet.absoluteFill}>
                    <View
                      style={{
                        position: 'absolute',
                        left: h.x * k - caretW / 2,
                        top,
                        width: caretW,
                        height: Math.max(bottom - top, 4),
                        backgroundColor: colors.selection,
                      }}
                    />
                    <View
                      style={{
                        position: 'absolute',
                        left: h.x * k - knob / 2,
                        top: which === 'start' ? top - knob + 1 / z : bottom - 1 / z,
                        width: knob,
                        height: knob,
                        borderRadius: knob / 2,
                        backgroundColor: colors.selection,
                      }}
                    />
                  </View>
                );
              })}

              {/* 5. Screen-provided overlays (search hits, ink preview, placement) */}
              {renderOverlay && (
                <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                  {renderOverlay({ baseScale, canvasWidth, canvasHeight, zoom: zoomMirror })}
                </View>
              )}
            </View>
          )}
        </Animated.View>
      </View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({
  viewportContainer: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  canvasWrapper: {
    backgroundColor: '#FFFFFF',
    borderRadius: 2,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 10,
    elevation: 5,
  },
  knockoutPatch: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
  },
  liveText: {
    position: 'absolute',
    includeFontPadding: false,
  },
  selectedHighlight: {
    position: 'absolute',
    borderRadius: 2,
    opacity: 0.24,
  },
});
