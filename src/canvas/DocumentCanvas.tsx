import React, { useRef, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Image,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
} from 'react-native-reanimated';
import {
  Canvas,
  Rect,
  Group,
  RoundedRect,
  matchFont,
  Text as SkiaText,
  Image as SkiaImage,
  useImage,
} from '@shopify/react-native-skia';
import { AddedTextElement, TextRegion } from '../types/document';
import { DocumentPoint, DocumentRect, ViewportTransform } from '../types/geometry';
import { rectContainsPoint } from '../utils/coordinates';
import { rectContainsPointWithTolerance } from '../features/ocr/hitTesting';
import { fitTextToBoundingBox } from '../features/text/textFitting';
import { colors } from '../constants/theme';

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

interface ReplacementTextItemProps {
  region: TextRegion;
}

const ReplacementTextItem: React.FC<ReplacementTextItemProps> = ({
  region,
}) => {
  const { fittedFontSize, baselineY } = fitTextToBoundingBox(
    region.bounds,
    region.originalText,
    region.currentText,
    region.style,
  );

  const font = matchFont({
    fontFamily: region.style.fontFamily || 'sans-serif',
    fontSize: Math.max(7, Math.round(fittedFontSize)),
    fontWeight: (region.style.fontWeight as any) || 'normal',
    fontStyle: region.style.fontStyle || 'normal',
  });

  if (!font) return null;

  return (
    <SkiaText
      x={region.bounds.x + 1}
      y={baselineY}
      text={region.currentText}
      font={font}
      color={region.style.color || '#111827'}
    />
  );
};

interface AddedTextItemProps {
  element: AddedTextElement;
}

const AddedTextItem: React.FC<AddedTextItemProps> = ({ element }) => {
  const fontSize = element.style.fontSize || 16;
  const baselineY = element.bounds.y + fontSize * 0.85;

  const font = matchFont({
    fontFamily: element.style.fontFamily || 'sans-serif',
    fontSize: Math.max(7, Math.round(fontSize)),
    fontWeight: (element.style.fontWeight as any) || 'normal',
    fontStyle: element.style.fontStyle || 'normal',
  });

  if (!font) return null;

  return (
    <SkiaText
      x={element.bounds.x}
      y={baselineY}
      text={element.text}
      font={font}
      color={element.style.color || '#111827'}
    />
  );
};

export interface DocumentCanvasProps {
  transform: ViewportTransform;
  onTransformChange?: (transform: ViewportTransform) => void;
  documentWidth: number;
  documentHeight: number;
  imageUri?: string;
  textRegions?: TextRegion[];
  addedText?: AddedTextElement[];
  selectedRegionId?: string | null;
  selectedAddedTextId?: string | null;
  onSelectRegion?: (region: TextRegion | null) => void;
  onSelectAddedText?: (element: AddedTextElement | null) => void;
  onTapLocation?: (point: DocumentPoint) => void;
  isInsertMode?: boolean;
}

export const DocumentCanvas: React.FC<DocumentCanvasProps> = ({
  transform,
  onTransformChange,
  documentWidth,
  documentHeight,
  imageUri,
  textRegions = [],
  addedText = [],
  selectedRegionId = null,
  selectedAddedTextId = null,
  onSelectRegion,
  onSelectAddedText,
  onTapLocation,
  isInsertMode = false,
}) => {
  const theme = colors.light;
  const resolvedUri = imageUri ? (imageUri.startsWith('/') ? 'file://' + imageUri : imageUri) : '';
  const skImage = useImage(resolvedUri, (err) => {
    console.warn('Skia useImage error loading:', resolvedUri, err);
  });

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
        scale: Math.round(newScale * 100) / 100,
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

      // Check added text elements first (top-level)
      const clickedAdded = [...addedText]
        .reverse()
        .find((el) => rectContainsPoint(el.bounds, docTap));

      if (clickedAdded) {
        onSelectAddedText?.(clickedAdded);
        onSelectRegion?.(null);
        return;
      }

      // Check detected/modified OCR text regions (exact match first, then 6px tolerance for small text)
      let clickedRegion = [...textRegions]
        .reverse()
        .find(
          (region) =>
            region.status !== 'deleted' &&
            rectContainsPoint(region.bounds, docTap),
        );

      if (!clickedRegion) {
        clickedRegion = [...textRegions]
          .reverse()
          .find(
            (region) =>
              region.status !== 'deleted' &&
              rectContainsPointWithTolerance(region.bounds, docTap, 6),
          );
      }

      onSelectRegion?.(clickedRegion || null);
      onSelectAddedText?.(null);
    },
    [isInsertMode, addedText, textRegions, onTapLocation, onSelectAddedText, onSelectRegion],
  );

  handleTapRef.current = handleTap;

  // Two-Finger Pinch Gesture with Focal Point tracking (Phase 2 bounded 0.5 - 4.0)
  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      'worklet';
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(logGestureEvent)('PINCH_START', 'scale=' + Math.round(scale.value * 100) / 100);
    })
    .onUpdate((e) => {
      'worklet';
      const nextScale = Math.min(Math.max(savedScale.value * e.scale, 0.5), 4.0);
      const scaleRatio = nextScale / savedScale.value;
      // Focal point zoom: keep point under fingers pinned
      translateX.value = e.focalX - (e.focalX - savedTranslateX.value) * scaleRatio;
      translateY.value = e.focalY - (e.focalY - savedTranslateY.value) * scaleRatio;
      scale.value = nextScale;
      runOnJS(logThrottledUpdate)('PINCH', 'scale=' + Math.round(nextScale * 100) / 100);
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(notifyTransformChange)(scale.value, translateX.value, translateY.value);
      runOnJS(logGestureEvent)('PINCH_END', 'scale=' + Math.round(scale.value * 100) / 100);
    });

  // Pan Gesture (supports 1 and 2 finger panning with Phase 2 diagnostics)
  const panGesture = Gesture.Pan()
    .minDistance(10)
    .minPointers(1)
    .maxPointers(2)
    .onStart(() => {
      'worklet';
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(logGestureEvent)('PAN_START', 'tx=' + Math.round(translateX.value) + ' ty=' + Math.round(translateY.value));
    })
    .onUpdate((e) => {
      'worklet';
      const curTx = savedTranslateX.value + e.translationX;
      const curTy = savedTranslateY.value + e.translationY;
      translateX.value = curTx;
      translateY.value = curTy;
      runOnJS(logThrottledUpdate)('PAN', 'tx=' + Math.round(curTx) + ' ty=' + Math.round(curTy));
    })
    .onEnd(() => {
      'worklet';
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(notifyTransformChange)(scale.value, translateX.value, translateY.value);
      runOnJS(logGestureEvent)('PAN_END', 'tx=' + Math.round(translateX.value) + ' ty=' + Math.round(translateY.value));
    });

  // Tap Gesture: comfortable physical touch duration and movement tolerance
  const tapGesture = Gesture.Tap()
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

  // Regions needing background patch (both modified and deleted)
  const patchedRegions = textRegions.filter(
    (r) => (r.status === 'modified' || r.status === 'deleted') && !!r.reconstructedPatchUri,
  );

  // Regions with active replacement text (modified only)
  const replacementRegions = textRegions.filter(
    (r) => r.status === 'modified' && !!r.currentText && r.currentText.trim().length > 0,
  );

  // Active visible regions for selection box overlay (exclude deleted)
  const visibleRegions = textRegions.filter((r) => r.status !== 'deleted');

  return (
    <View style={styles.container}>
      <GestureDetector gesture={composedGestures}>
        <View style={styles.gestureCatchArea}>
          <Animated.View
            style={[
              styles.animatedWrapper,
              {
                width: documentWidth,
                height: documentHeight,
                position: 'relative',
              },
              animatedStyle,
            ]}>
            {/* Unified Image Rendering: Native fallback only if Skia has not loaded */}
            {imageUri && !skImage ? (
              <Image
                source={{ uri: imageUri }}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: documentWidth,
                  height: documentHeight,
                  borderRadius: 4,
                }}
                resizeMode="cover"
              />
            ) : null}

            <Canvas style={{ width: documentWidth, height: documentHeight, backgroundColor: 'transparent' }}>
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

              {/* Immutable Source Image Layer */}
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
                {patchedRegions.map((region) => (
                  <PatchItem
                    key={`patch-${region.id}`}
                    patchUri={region.reconstructedPatchUri}
                    bounds={region.reconstructedPatchBounds || region.bounds}
                    fallbackColor="#FFFFFF"
                  />
                ))}
              </Group>

              {/* Replacement Text Layer */}
              <Group>
                {replacementRegions.map((region) => (
                  <ReplacementTextItem
                    key={`text-${region.id}`}
                    region={region}
                  />
                ))}
              </Group>

              {/* Added Text Elements Layer */}
              <Group>
                {addedText.map((element) => (
                  <AddedTextItem
                    key={`added-${element.id}`}
                    element={element}
                  />
                ))}
              </Group>

              {/* Interactive OCR Bounding Box & Selection Overlays */}
              <Group>
                {visibleRegions.map((region) => {
                  const isSelected = region.id === selectedRegionId;
                  const isModified = region.status === 'modified';

                  return (
                    <Group key={region.id}>
                      {/* Highlight Background Tint */}
                      <Rect
                        x={region.bounds.x}
                        y={region.bounds.y}
                        width={region.bounds.width}
                        height={region.bounds.height}
                        color={
                          isSelected
                            ? 'rgba(0, 122, 255, 0.22)'
                            : isModified
                              ? 'rgba(52, 199, 89, 0.08)'
                              : 'rgba(0, 122, 255, 0.06)'
                        }
                      />

                      {/* Bounding Box Border */}
                      <Rect
                        x={region.bounds.x}
                        y={region.bounds.y}
                        width={region.bounds.width}
                        height={region.bounds.height}
                        color={
                          isSelected
                            ? theme.primary
                            : isModified
                              ? 'rgba(52, 199, 89, 0.7)'
                              : 'rgba(0, 122, 255, 0.45)'
                        }
                        style="stroke"
                        strokeWidth={isSelected ? 2 : 1}
                      />

                      {/* Selection corner handles */}
                      {isSelected && (
                        <Group>
                          <Rect
                            x={region.bounds.x - 3}
                            y={region.bounds.y - 3}
                            width={6}
                            height={6}
                            color={theme.primary}
                          />
                          <Rect
                            x={region.bounds.x + region.bounds.width - 3}
                            y={region.bounds.y - 3}
                            width={6}
                            height={6}
                            color={theme.primary}
                          />
                          <Rect
                            x={region.bounds.x - 3}
                            y={region.bounds.y + region.bounds.height - 3}
                            width={6}
                            height={6}
                            color={theme.primary}
                          />
                          <Rect
                            x={region.bounds.x + region.bounds.width - 3}
                            y={region.bounds.y + region.bounds.height - 3}
                            width={6}
                            height={6}
                            color={theme.primary}
                          />
                        </Group>
                      )}
                    </Group>
                  );
                })}

                {/* Overlays for Added Text elements */}
                {addedText.map((element) => {
                  const isSelected = element.id === selectedAddedTextId;

                  return (
                    <Group key={`overlay-${element.id}`}>
                      <Rect
                        x={element.bounds.x}
                        y={element.bounds.y}
                        width={element.bounds.width}
                        height={element.bounds.height}
                        color={
                          isSelected
                            ? 'rgba(0, 122, 255, 0.22)'
                            : 'rgba(99, 102, 241, 0.08)'
                        }
                      />
                      <Rect
                        x={element.bounds.x}
                        y={element.bounds.y}
                        width={element.bounds.width}
                        height={element.bounds.height}
                        color={isSelected ? theme.primary : '#6366F1'}
                        style="stroke"
                        strokeWidth={isSelected ? 2 : 1}
                      />
                    </Group>
                  );
                })}
              </Group>
            </Canvas>
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.canvasBackground,
    overflow: 'hidden',
  },
  gestureCatchArea: {
    flex: 1,
  },
  animatedWrapper: {
    // origin at top-left so transform math is straightforward
  },
});
