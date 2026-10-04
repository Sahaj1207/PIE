import React, { useCallback, useRef } from 'react';
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
} from 'react-native-reanimated';
import {
  PdfRenderedPage,
  PdfTextObject,
  PdfSelectionState,
  PdfTextEditCommand,
  PdfInsertCommand,
  PdfReplaceCommand,
} from '../types';
import { documentToScreenRect, hitTestTextObjects } from '../pdfiumEngine';
import { viewportPointToDocumentPoint } from '../pdfViewportMath';
import { colors } from '../../../constants/theme';

interface PdfViewportProps {
  page: PdfRenderedPage | null;
  textObjects: PdfTextObject[];
  originalTextObjects?: PdfTextObject[];
  pendingEdits?: readonly PdfTextEditCommand[];
  selectedObjectId?: string | null;
  selectionState?: PdfSelectionState | null;
  onSelectObject: (obj: PdfTextObject | null) => void;
  isPlacementMode?: boolean;
  onPlaceTextAt?: (point: { x: number; y: number }) => void;
  viewportWidth?: number;
  viewportHeight?: number;
}

export const PdfViewport: React.FC<PdfViewportProps> = ({
  page,
  textObjects,
  originalTextObjects = [],
  pendingEdits = [],
  selectedObjectId,
  selectionState,
  onSelectObject,
  isPlacementMode = false,
  onPlaceTextAt,
  viewportWidth = Dimensions.get('window').width,
  viewportHeight = Dimensions.get('window').height * 0.7,
}) => {
  const theme = colors.light;

  // Shared values for smooth 60fps GPU pan & pinch zoom on UI thread
  const scale = useSharedValue(1.0);
  const savedScale = useSharedValue(1.0);
  const translateX = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  // Keep JS-accessible mirror of transform for tap hit-testing
  const transformRef = useRef({ scale: 1.0, translateX: 0, translateY: 0 });

  const updateTransformMirror = useCallback(
    (s: number, tx: number, ty: number) => {
      transformRef.current = { scale: s, translateX: tx, translateY: ty };
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
      if (!page) return;
      const { scale: curScale, translateX: curTx, translateY: curTy } = transformRef.current;
      const point = viewportPointToDocumentPoint(
        { x: viewportX, y: viewportY },
        {
          baseScale,
          pageOriginX,
          pageOriginY,
          zoom: curScale,
          translateX: curTx,
          translateY: curTy,
        },
      );

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

      // Hit-test vector text objects in document coordinates (with generous touch tolerance)
      console.log('[PHASE3_PDF] HIT_TEST_START candidates=' + textObjects.length);
      const tolerance = Math.max(12 / baseScale / curScale, 10);
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
      pageOriginX,
      pageOriginY,
      isPlacementMode,
      onPlaceTextAt,
      textObjects,
      onSelectObject,
    ],
  );

  handleTapDocRef.current = handleTapDoc;

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
      // Keep point under fingers pinned
      const focalX = e.focalX - pageOriginX;
      const focalY = e.focalY - pageOriginY;
      translateX.value = focalX - (focalX - savedTranslateX.value) * scaleRatio;
      translateY.value = focalY - (focalY - savedTranslateY.value) * scaleRatio;
      scale.value = nextScale;
      runOnJS(logThrottledUpdate)('PINCH', 'scale=' + Math.round(nextScale * 100) / 100);
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(updateTransformMirror)(scale.value, translateX.value, translateY.value);
      runOnJS(logGestureEvent)('PINCH_END', 'scale=' + Math.round(scale.value * 100) / 100);
    });

  // Pan Gesture (1 or 2 fingers) with minimum drag distance to prevent tap interference
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
      runOnJS(updateTransformMirror)(scale.value, translateX.value, translateY.value);
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

  // Tap has priority on quick stationary release; deliberate drag engages pan; pinch runs simultaneously
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

  // Find currently selected object / bounds (supports selectionState or selectedObjectId)
  const activeSelectedId = selectionState?.selectedObjectId ?? selectedObjectId ?? null;
  const selectedObject = activeSelectedId
    ? textObjects.find((o) => o.id === activeSelectedId) || null
    : null;

  const activeDocBounds = selectionState?.selectedBounds ?? selectedObject?.bounds ?? null;
  const selectedScreenRect = activeDocBounds
    ? documentToScreenRect(activeDocBounds, baseScale, baseScale)
    : null;

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
          { width: viewportWidth, height: viewportHeight },
        ]}>
        <Animated.View
          style={[
            styles.canvasWrapper,
            {
              position: 'absolute',
              left: pageOriginX,
              top: pageOriginY,
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

              {/* 4. Selection Highlight Layer (ONLY around the single active selected text object) */}
              {selectedScreenRect && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.selectedHighlight,
                    {
                      left: selectedScreenRect.x - 2,
                      top: selectedScreenRect.y - 1,
                      width: Math.max(selectedScreenRect.width + 4, 10),
                      height: Math.max(selectedScreenRect.height + 2, 14),
                    },
                  ]}
                />
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
    backgroundColor: '#F2F2F7',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  canvasWrapper: {
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 4,
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
    borderWidth: 1.5,
    borderColor: '#007AFF',
    backgroundColor: 'rgba(0, 122, 255, 0.14)',
    borderRadius: 3,
  },
});
