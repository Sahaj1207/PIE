import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ActivityIndicator,
  Platform,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import {
  useSharedValue,
  useDerivedValue,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Canvas,
  Rect,
  Group,
  RoundedRect,
  matchFont,
  Text as SkiaText,
  Image as SkiaImage,
  Path as SkiaPath,
  Skia,
  useImage,
  type Transforms3d,
} from '@shopify/react-native-skia';
import { AddedTextElement, ImageDrawing, TextRegion } from '../types/document';
import { commandsToSvg, PathCommand } from '../features/markup/inkPath';
import { useTheme } from '../ui/ThemeProvider';
import { DocumentPoint, DocumentRect, ViewportTransform } from '../types/geometry';
import {
  DRAG_TOUCH_SLOP_PT,
  MIN_ADDED_TEXT_FONT_SIZE,
  ManipulableLayer,
  PINCH_TARGET_SLOP_PT,
  TAP_TOLERANCE_PT,
  clampManipulationScale,
  hitTestImageCanvas,
  hitTestManipulableLayer,
  ImageCanvasHit,
  maxAddedTextFontSize,
  pinchTargetsLayer,
  screenToDocumentTolerance,
  toManipulableLayers,
} from '../features/image/imageCanvasInteraction';
import {
  buildImageRenderPlan,
  RenderDrawingLayer,
  RenderTextLayer,
} from '../features/image/imageRenderPlan';
import { defaultTextMeasurer } from '../features/image/textMeasurement';
import { platformFontFamily, resolveRenderableFontFamily } from '../features/text/textLayout';
import { MIN_IMAGE_SCALE, MAX_IMAGE_SCALE } from '../features/image/imageViewportMath';

/**
 * In-progress direct manipulation of one added-text layer (UI thread). dx/dy are in
 * DOCUMENT pixels; s scales the layer around its centre (cx, cy). Committed once on release.
 */
interface ManipulationState {
  readonly id: string;
  readonly dx: number;
  readonly dy: number;
  readonly s: number;
  readonly cx: number;
  readonly cy: number;
}

const IDLE_MANIPULATION: ManipulationState = { id: '', dx: 0, dy: 0, s: 1, cx: 0, cy: 0 };

/** Applies the live manipulation transform to one added-text layer (identity otherwise). */
const ManipulatedGroup: React.FC<{
  layerId: string;
  manipulation: SharedValue<ManipulationState>;
  children: React.ReactNode;
}> = ({ layerId, manipulation, children }) => {
  const transform = useDerivedValue<Transforms3d>(() => {
    const m = manipulation.value;
    if (m.id !== layerId) return [{ translateX: 0 }];
    return [
      { translateX: m.cx + m.dx },
      { translateY: m.cy + m.dy },
      { scale: m.s },
      { translateX: -m.cx },
      { translateY: -m.cy },
    ];
  });
  return <Group transform={transform}>{children}</Group>;
};

interface PatchItemProps {
  patchUri?: string;
  bounds: DocumentRect;
  fallbackColor?: string;
}

const PatchItem: React.FC<PatchItemProps> = ({
  patchUri,
  bounds,
  fallbackColor,
}) => {
  const patchImg = useImage(patchUri || '');

  if (patchImg) {
    return (
      <SkiaImage
        image={patchImg}
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fit="fill"
      />
    );
  }

  if (fallbackColor) {
    return (
      <Rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        color={fallbackColor}
      />
    );
  }

  return null;
};

/** One markup path (document pixels). */
const DrawingItem: React.FC<{ layer: Pick<RenderDrawingLayer, 'commands' | 'color' | 'width' | 'opacity' | 'multiply'> }> = ({ layer }) => {
  const path = useMemo(
    () => Skia.Path.MakeFromSVGString(commandsToSvg(layer.commands as unknown as PathCommand[])),
    [layer.commands],
  );
  if (!path) return null;
  return (
    <SkiaPath
      path={path}
      color={layer.color}
      opacity={layer.opacity}
      style="stroke"
      strokeWidth={layer.width}
      strokeCap="round"
      strokeJoin="round"
      blendMode={layer.multiply ? 'multiply' : 'srcOver'}
    />
  );
};

/** Live stroke while drawing (not yet part of the document). */
export interface LiveDrawing {
  readonly commands: readonly PathCommand[];
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
  readonly multiply: boolean;
}

interface TextLayerItemProps {
  layer: RenderTextLayer;
}

/**
 * Renders one text layer from the shared ImageRenderPlan (identical lines and positions are
 * sent to the native exporter, so the export matches what is drawn here). Lines are drawn
 * exactly as planned; no re-wrapping happens in the renderer.
 */
const TextLayerItem: React.FC<TextLayerItemProps> = ({ layer }) => {
  const font = matchFont({
    fontFamily: platformFontFamily(resolveRenderableFontFamily(layer.fontFamily), Platform.OS),
    fontSize: layer.fittedFontSize,
    fontWeight: layer.fontWeight as any,
    fontStyle: layer.fontStyle,
  });

  if (!font) return null;

  return (
    <Group>
      {layer.lines.map((line, index) =>
        line.text.length > 0 ? (
          <SkiaText
            key={`line-${index}`}
            x={line.x}
            y={line.baselineY}
            text={line.text}
            font={font}
            color={layer.color}
          />
        ) : null,
      )}
    </Group>
  );
};

export interface DocumentCanvasProps {
  transform: ViewportTransform;
  onTransformChange?: (transform: ViewportTransform) => void;
  documentWidth: number;
  documentHeight: number;
  /** Full-resolution working image (document coordinate space = its pixel grid). */
  imageUri?: string;
  /**
   * Optional downsampled display proxy. It is drawn stretched to documentWidth x
   * documentHeight, so document coordinates are identical with or without it.
   */
  previewUri?: string;
  /** Absolute zoom bounds (see resolveImageZoomBounds). Default 0.5 – 4.0. */
  minScale?: number;
  maxScale?: number;
  textRegions?: TextRegion[];
  addedText?: AddedTextElement[];
  selectedRegionId?: string | null;
  selectedAddedTextId?: string | null;
  /**
   * Selection on the canvas: the hit under a tap (null = empty area), or the added-text layer a
   * one-finger drag started on ('drag'). Exactly one event per gesture.
   */
  onSelectionHit?: (hit: ImageCanvasHit | null, source: 'tap' | 'drag') => void;
  /**
   * Called once when a direct manipulation of an added-text layer ends (all fingers up):
   * one-finger move (dx/dy in DOCUMENT pixels, i.e. screen delta / zoom) and/or two-finger
   * resize (uniform `scale` around the layer centre). Returns true when the document changed.
   */
  onManipulateAddedText?: (id: string, manipulation: { dx: number; dy: number; scale: number }) => boolean;
  onTapLocation?: (point: DocumentPoint) => void;
  isInsertMode?: boolean;
  /** Markup drawings of the page (rendered above all other layers). */
  drawings?: ImageDrawing[];
  /** Draw mode: one finger draws (document points via onDraw*), two fingers zoom/pan. */
  drawMode?: boolean;
  liveDrawing?: LiveDrawing | null;
  onDrawStart?: (point: DocumentPoint) => void;
  onDrawMove?: (point: DocumentPoint) => void;
  onDrawEnd?: () => void;
  /** Hide OCR boxes / added-text frames (markup, crop and placement modes). */
  hideOverlays?: boolean;
}

export const DocumentCanvas: React.FC<DocumentCanvasProps> = ({
  transform,
  onTransformChange,
  documentWidth,
  documentHeight,
  imageUri,
  previewUri,
  minScale = MIN_IMAGE_SCALE,
  maxScale = MAX_IMAGE_SCALE,
  textRegions = [],
  addedText = [],
  selectedRegionId = null,
  selectedAddedTextId = null,
  onSelectionHit,
  onManipulateAddedText,
  onTapLocation,
  isInsertMode = false,
  drawings = [],
  drawMode = false,
  liveDrawing = null,
  onDrawStart,
  onDrawMove,
  onDrawEnd,
  hideOverlays = false,
}) => {
  const { colors: theme } = useTheme();
  const displaySource = previewUri || imageUri;
  const resolvedUri = displaySource
    ? (displaySource.startsWith('/') ? 'file://' + displaySource : displaySource)
    : '';
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const skImage = useImage(resolvedUri, (err) => {
    console.warn('Skia useImage error loading:', resolvedUri, err);
    setImageLoadFailed(true);
  });

  useEffect(() => {
    setImageLoadFailed(false);
  }, [resolvedUri]);

  useEffect(() => {
    if (resolvedUri) {
      console.log('[PHASE1_IMAGE] IMAGE_RENDER_SUCCESS: ' + resolvedUri + ' (' + documentWidth + 'x' + documentHeight + ')');
    }
  }, [resolvedUri, documentWidth, documentHeight]);

  // Reanimated shared values for smooth 60fps GPU pan & pinch zoom
  const scale = useSharedValue(transform.scale);
  const savedScale = useSharedValue(transform.scale);
  const translateX = useSharedValue(transform.translateX);
  const savedTranslateX = useSharedValue(transform.translateX);
  const translateY = useSharedValue(transform.translateY);
  const savedTranslateY = useSharedValue(transform.translateY);

  const currentTransformRef = useRef<ViewportTransform>(transform);
  currentTransformRef.current = transform;

  // Sync external transform changes (e.g. from Fit or Zoom buttons)
  useEffect(() => {
    scale.value = transform.scale;
    savedScale.value = transform.scale;
    translateX.value = transform.translateX;
    savedTranslateX.value = transform.translateX;
    translateY.value = transform.translateY;
    savedTranslateY.value = transform.translateY;
  }, [transform.scale, transform.translateX, transform.translateY, scale, savedScale, translateX, savedTranslateX, translateY, savedTranslateY]);

  // Stable ref for RNGH tap callback to prevent stale closures
  const handleTapRef = useRef<(sx: number, sy: number) => void>(() => { });

  const onExecuteTap = useCallback((sx: number, sy: number) => {
    handleTapRef.current(sx, sy);
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

  const notifyTransformChange = useCallback(
    (newScale: number, tx: number, ty: number) => {
      onTransformChange?.({
        // 4 decimals: large images fit at scales ~0.05–0.2 where 2-decimal rounding jumps.
        scale: Math.round(newScale * 10000) / 10000,
        translateX: Math.round(tx),
        translateY: Math.round(ty),
      });
    },
    [onTransformChange],
  );

  const handleTap = useCallback(
    (screenX: number, screenY: number) => {
      // Inverse transform: screen coord -> document coord
      const cur = currentTransformRef.current;
      const docX = (screenX - cur.translateX) / cur.scale;
      const docY = (screenY - cur.translateY) / cur.scale;
      const docTap: DocumentPoint = { x: docX, y: docY };

      console.log('[PHASE2_GESTURE] TAP doc=(' + Math.round(docX) + ',' + Math.round(docY) + ')');

      // In Insert Mode: emit document location with margin clamping
      if (isInsertMode) {
        const clampedX = Math.max(16, Math.min(documentWidth - 16, Math.max(0, docX)));
        const clampedY = Math.max(16, Math.min(documentHeight - 16, Math.max(0, docY)));
        onTapLocation?.({ x: Math.round(clampedX), y: Math.round(clampedY) });
        return;
      }

      // Finger-sized tolerance in SCREEN points, whatever the zoom / image resolution.
      // Added layers and OCR regions are distinct hit kinds (never confused).
      const hit = hitTestImageCanvas(
        docTap,
        addedText,
        textRegions,
        screenToDocumentTolerance(TAP_TOLERANCE_PT, cur.scale),
      );
      onSelectionHit?.(hit, 'tap');
    },
    [isInsertMode, addedText, textRegions, onTapLocation, onSelectionHit, documentWidth, documentHeight],
  );

  handleTapRef.current = handleTap;

  const drawRef = useRef({ start: onDrawStart, move: onDrawMove, end: onDrawEnd });
  drawRef.current = { start: onDrawStart, move: onDrawMove, end: onDrawEnd };
  const jsDrawStart = useCallback((x: number, y: number) => drawRef.current.start?.({ x, y }), []);
  const jsDrawMove = useCallback((x: number, y: number) => drawRef.current.move?.({ x, y }), []);
  const jsDrawEnd = useCallback(() => drawRef.current.end?.(), []);

  // ---- Direct manipulation of added-text layers --------------------------------------------
  // One finger on an added layer moves it (selecting it); two fingers on the selected layer
  // resize it. Live feedback is a UI-thread transform; the document changes once, on release.
  const manipulationEnabled = !!onManipulateAddedText && !isInsertMode && !drawMode;
  const layersSV = useSharedValue<ManipulableLayer[]>([]);
  const selectedIdSV = useSharedValue<string>('');
  const maxFontSV = useSharedValue<number>(maxAddedTextFontSize({ width: documentWidth, height: documentHeight }));
  const manipulation = useSharedValue<ManipulationState>(IDLE_MANIPULATION);
  const manipPanning = useSharedValue(false);
  const manipPinching = useSharedValue(false);
  const panBaseDx = useSharedValue(0);
  const panBaseDy = useSharedValue(0);
  const pinchBase = useSharedValue(1);
  const pinchFont = useSharedValue(16);

  const addedTextRef = useRef(addedText);
  addedTextRef.current = addedText;

  useLayoutEffect(() => {
    layersSV.value = manipulationEnabled ? toManipulableLayers(addedText) : [];
    selectedIdSV.value = manipulationEnabled ? selectedAddedTextId ?? '' : '';
    maxFontSV.value = maxAddedTextFontSize({ width: documentWidth, height: documentHeight });
  }, [addedText, selectedAddedTextId, manipulationEnabled, documentWidth, documentHeight, layersSV, selectedIdSV, maxFontSV]);

  useLayoutEffect(() => {
    // New layer geometry arrived (manipulation committed, undo, edit): drop the live offset,
    // unless a gesture is still in progress.
    if (!manipPanning.value && !manipPinching.value) {
      manipulation.value = IDLE_MANIPULATION;
    }
  }, [addedText, manipulation, manipPanning, manipPinching]);

  const selectLayerById = useCallback(
    (id: string) => {
      const el = addedTextRef.current.find((item) => item.id === id);
      if (el) {
        onSelectionHit?.({ kind: 'added', element: el }, 'drag');
      }
    },
    [onSelectionHit],
  );

  const commitManipulation = useCallback(
    (id: string, dx: number, dy: number, scaleFactor: number) => {
      const meaningful = Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 || Math.abs(scaleFactor - 1) >= 0.001;
      const changed = meaningful && onManipulateAddedText ? onManipulateAddedText(id, { dx, dy, scale: scaleFactor }) : false;
      // A change re-renders with new geometry (the effect above clears the live offset)
      if (!changed) {
        manipulation.value = IDLE_MANIPULATION;
      }
    },
    [onManipulateAddedText, manipulation],
  );

  /** Commits once every finger involved in the manipulation has lifted. */
  const finishManipulation = () => {
    'worklet';
    if (manipPanning.value || manipPinching.value) return;
    const m = manipulation.value;
    if (!m.id) return;
    runOnJS(commitManipulation)(m.id, m.dx, m.dy, m.s);
  };

  // Two-Finger Pinch Gesture with Focal Point tracking, bounded by fit-aware zoom limits.
  // A pinch on (or near) the selected added-text layer resizes that layer instead.
  const pinchGesture = Gesture.Pinch()
    .onStart((e) => {
      'worklet';
      const selId = selectedIdSV.value;
      if (selId && scale.value > 0) {
        const layers = layersSV.value;
        let target: ManipulableLayer | null = null;
        for (let i = 0; i < layers.length; i++) {
          if (layers[i].id === selId) target = layers[i];
        }
        if (target) {
          const focal = {
            x: (e.focalX - translateX.value) / scale.value,
            y: (e.focalY - translateY.value) / scale.value,
          };
          if (pinchTargetsLayer(target, focal, PINCH_TARGET_SLOP_PT / scale.value)) {
            manipPinching.value = true;
            if (manipulation.value.id !== target.id) {
              manipulation.value = {
                id: target.id,
                dx: 0,
                dy: 0,
                s: 1,
                cx: target.x + target.w / 2,
                cy: target.y + target.h / 2,
              };
            }
            pinchBase.value = manipulation.value.s;
            pinchFont.value = target.fontSize;
            return;
          }
        }
      }
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(logGestureEvent)('PINCH_START', 'scale=' + Math.round(scale.value * 100) / 100);
    })
    .onUpdate((e) => {
      'worklet';
      if (manipPinching.value) {
        const s = clampManipulationScale(
          pinchFont.value,
          pinchBase.value * e.scale,
          MIN_ADDED_TEXT_FONT_SIZE,
          maxFontSV.value,
        );
        manipulation.value = { ...manipulation.value, s };
        return;
      }
      const nextScale = Math.min(Math.max(savedScale.value * e.scale, minScale), maxScale);
      const scaleRatio = nextScale / savedScale.value;
      // Focal point zoom: keep point under fingers pinned
      translateX.value = e.focalX - (e.focalX - savedTranslateX.value) * scaleRatio;
      translateY.value = e.focalY - (e.focalY - savedTranslateY.value) * scaleRatio;
      scale.value = nextScale;
      runOnJS(logThrottledUpdate)('PINCH', 'scale=' + Math.round(nextScale * 100) / 100);
    })
    .onEnd(() => {
      'worklet';
      if (manipPinching.value) {
        manipPinching.value = false;
        finishManipulation();
        return;
      }
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(notifyTransformChange)(scale.value, translateX.value, translateY.value);
      runOnJS(logGestureEvent)('PINCH_END', 'scale=' + Math.round(scale.value * 100) / 100);
    });

  // Pan Gesture: one finger on an added-text layer moves it; otherwise 1-2 finger page pan.
  const panGesture = Gesture.Pan()
    .minDistance(drawMode ? 0 : 10)
    .minPointers(1)
    .maxPointers(drawMode ? 1 : 2)
    .onStart((e) => {
      'worklet';
      if (drawMode) {
        if (scale.value > 0) {
          runOnJS(jsDrawStart)((e.x - translateX.value) / scale.value, (e.y - translateY.value) / scale.value);
        }
        return;
      }
      if (manipPinching.value) {
        // Fingers moving during a text resize carry the text along (never pan the page)
        manipPanning.value = true;
        panBaseDx.value = manipulation.value.dx - e.translationX / scale.value;
        panBaseDy.value = manipulation.value.dy - e.translationY / scale.value;
        return;
      }
      const pointers = e.numberOfPointers ?? 1;
      if (pointers <= 1 && scale.value > 0 && layersSV.value.length > 0) {
        // Touch-down point (the pan activates after a few points of movement)
        const docX = (e.x - e.translationX - translateX.value) / scale.value;
        const docY = (e.y - e.translationY - translateY.value) / scale.value;
        const id = hitTestManipulableLayer(
          layersSV.value,
          { x: docX, y: docY },
          DRAG_TOUCH_SLOP_PT / scale.value,
          selectedIdSV.value || null,
        );
        if (id) {
          const layers = layersSV.value;
          let target: ManipulableLayer | null = null;
          for (let i = 0; i < layers.length; i++) {
            if (layers[i].id === id) target = layers[i];
          }
          if (target) {
            manipPanning.value = true;
            panBaseDx.value = 0;
            panBaseDy.value = 0;
            manipulation.value = {
              id,
              dx: e.translationX / scale.value,
              dy: e.translationY / scale.value,
              s: 1,
              cx: target.x + target.w / 2,
              cy: target.y + target.h / 2,
            };
            if (id !== selectedIdSV.value) {
              runOnJS(selectLayerById)(id);
            }
            return;
          }
        }
      }
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(logGestureEvent)('PAN_START', 'tx=' + Math.round(translateX.value) + ' ty=' + Math.round(translateY.value));
    })
    .onUpdate((e) => {
      'worklet';
      if (drawMode) {
        if (scale.value > 0) {
          runOnJS(jsDrawMove)((e.x - translateX.value) / scale.value, (e.y - translateY.value) / scale.value);
        }
        return;
      }
      if (manipPanning.value) {
        // Screen delta -> document delta (independent of zoom and pan): follows the finger
        manipulation.value = {
          ...manipulation.value,
          dx: panBaseDx.value + e.translationX / scale.value,
          dy: panBaseDy.value + e.translationY / scale.value,
        };
        return;
      }
      if (manipPinching.value) {
        return; // never pan the page while a text layer is being resized
      }
      const curTx = savedTranslateX.value + e.translationX;
      const curTy = savedTranslateY.value + e.translationY;
      translateX.value = curTx;
      translateY.value = curTy;
      runOnJS(logThrottledUpdate)('PAN', 'tx=' + Math.round(curTx) + ' ty=' + Math.round(curTy));
    })
    .onEnd(() => {
      'worklet';
      if (drawMode) {
        runOnJS(jsDrawEnd)();
        return;
      }
      if (manipPanning.value) {
        manipPanning.value = false;
        finishManipulation();
        return;
      }
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(notifyTransformChange)(scale.value, translateX.value, translateY.value);
      runOnJS(logGestureEvent)('PAN_END', 'tx=' + Math.round(translateX.value) + ' ty=' + Math.round(translateY.value));
    });

  // Tap Gesture: comfortable physical touch duration and movement tolerance
  const tapGesture = Gesture.Tap()
    .enabled(!drawMode)
    .maxDuration(400)
    .maxDistance(16)
    .onEnd((e, success) => {
      'worklet';
      if (success) {
        runOnJS(onExecuteTap)(e.x, e.y);
      }
    });

  const composedGestures = Gesture.Simultaneous(
    pinchGesture,
    Gesture.Exclusive(tapGesture, panGesture),
  );

  // Document -> viewport transform applied inside Skia. The Skia surface itself stays
  // viewport-sized, so its memory no longer scales with the image's pixel dimensions.
  // Equivalent to the previous top-left-origin [translate, scale] view transform.
  const documentTransform = useDerivedValue<Transforms3d>(() => [
    { translateX: translateX.value },
    { translateY: translateY.value },
    { scale: scale.value },
  ]);

  // Shared composition plan (same layers the exporter composites)
  // (built with the same measurer the exporter uses, so both get identical lines)
  const renderPlan = useMemo(
    () =>
      buildImageRenderPlan(
        { editableTextRegions: textRegions, addedText, drawings },
        { measureText: defaultTextMeasurer },
      ),
    [textRegions, addedText, drawings],
  );

  // Active visible regions for selection box overlay (exclude deleted)
  const visibleRegions = textRegions.filter((r) => r.status !== 'deleted');
  // One screen point in document pixels at the current zoom (overlay strokes stay crisp)
  const px = transform.scale > 0 ? 1 / transform.scale : 1;

  const showLoading = !!displaySource && !skImage && !imageLoadFailed;

  return (
    <View style={[styles.container, { backgroundColor: theme.canvasBackground }]}>
      <GestureDetector gesture={composedGestures}>
        <View style={styles.gestureCatchArea}>
          <Canvas style={StyleSheet.absoluteFill}>
            <Group transform={documentTransform}>
              {/* Document Surface Shadow & Base Surface - only when no image document */}
              {!imageUri && (
                <Group>
                  <RoundedRect
                    x={2}
                    y={4}
                    width={documentWidth}
                    height={documentHeight}
                    r={4}
                    color={theme.canvasShadow}
                  />
                  <RoundedRect
                    x={0}
                    y={0}
                    width={documentWidth}
                    height={documentHeight}
                    r={4}
                    color={theme.canvasPage}
                  />
                </Group>
              )}

              {/* Immutable Source Image Layer (display proxy stretched to document space) */}
              {skImage && (
                <Group>
                  <SkiaImage
                    image={skImage}
                    x={0}
                    y={0}
                    width={documentWidth}
                    height={documentHeight}
                    fit="fill"
                  />
                </Group>
              )}

              {/* Cleaned Background Patches Layer */}
              <Group>
                {renderPlan.patches.map((patch) => (
                  <PatchItem
                    key={`patch-${patch.regionId}`}
                    patchUri={patch.patchUri}
                    bounds={patch.bounds}
                    fallbackColor="#FFFFFF"
                  />
                ))}
              </Group>

              {/* Replacement Text + Added Text Layers */}
              <Group>
                {renderPlan.textElements.map((layer) =>
                  layer.kind === 'added' ? (
                    // Added layers follow an in-progress move/resize (committed on release)
                    <ManipulatedGroup
                      key={`${layer.kind}-${layer.sourceId}`}
                      layerId={layer.sourceId}
                      manipulation={manipulation}>
                      <TextLayerItem layer={layer} />
                    </ManipulatedGroup>
                  ) : (
                    <TextLayerItem
                      key={`${layer.kind}-${layer.sourceId}`}
                      layer={layer}
                    />
                  ),
                )}
              </Group>

              {/* Markup layer (ink, highlighter, shapes, signatures) + live stroke */}
              <Group>
                {renderPlan.drawings.map((d) => (
                  <DrawingItem key={`drawing-${d.id}`} layer={d} />
                ))}
                {liveDrawing && liveDrawing.commands.length > 0 && <DrawingItem layer={liveDrawing} />}
              </Group>

              {/* Interactive OCR Bounding Box & Selection Overlays (screen-constant strokes) */}
              {!hideOverlays && <Group>
                {visibleRegions.map((region) => {
                  const isSelected = region.id === selectedRegionId;
                  const isModified = region.status === 'modified';
                  const pad = (isSelected ? 2 : 1) * px;
                  const rect = {
                    x: region.bounds.x - pad,
                    y: region.bounds.y - pad,
                    width: region.bounds.width + pad * 2,
                    height: region.bounds.height + pad * 2,
                  };
                  return (
                    <Group key={region.id}>
                      <RoundedRect
                        {...rect}
                        r={3 * px}
                        color={
                          isSelected
                            ? theme.selectionFill
                            : isModified
                              ? 'rgba(52, 199, 89, 0.08)'
                              : 'rgba(0, 122, 255, 0.07)'
                        }
                      />
                      <RoundedRect
                        {...rect}
                        r={3 * px}
                        color={
                          isSelected
                            ? theme.selection
                            : isModified
                              ? 'rgba(52, 199, 89, 0.55)'
                              : 'rgba(0, 122, 255, 0.38)'
                        }
                        style="stroke"
                        strokeWidth={(isSelected ? 1.5 : 1) * px}
                      />
                    </Group>
                  );
                })}

                {/* Overlays for Added Text elements */}
                {addedText.map((element) => {
                  const isSelected = element.id === selectedAddedTextId;
                  const pad = 2 * px;
                  const rect = {
                    x: element.bounds.x - pad,
                    y: element.bounds.y - pad,
                    width: element.bounds.width + pad * 2,
                    height: element.bounds.height + pad * 2,
                  };
                  return (
                    <ManipulatedGroup
                      key={`overlay-${element.id}`}
                      layerId={element.id}
                      manipulation={manipulation}>
                      <RoundedRect {...rect} r={3 * px} color={isSelected ? theme.selectionFill : 'rgba(99, 102, 241, 0.06)'} />
                      <RoundedRect
                        {...rect}
                        r={3 * px}
                        color={isSelected ? theme.selection : 'rgba(99, 102, 241, 0.45)'}
                        style="stroke"
                        strokeWidth={(isSelected ? 1.5 : 1) * px}
                      />
                    </ManipulatedGroup>
                  );
                })}
              </Group>}
            </Group>
          </Canvas>

          {showLoading && (
            <View style={styles.statusOverlay} pointerEvents="none">
              <ActivityIndicator size="small" color={theme.primary} />
            </View>
          )}
          {imageLoadFailed && (
            <View style={styles.statusOverlay} pointerEvents="none">
              <Text style={[styles.statusText, { color: theme.textSecondary }]}>
                The image could not be displayed.
              </Text>
            </View>
          )}
        </View>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  gestureCatchArea: {
    flex: 1,
  },
  statusOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
