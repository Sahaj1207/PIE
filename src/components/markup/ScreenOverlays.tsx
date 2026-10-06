/**
 * Screen-space editing overlays drawn above the image canvas:
 *  - PlacementBox: drag to move, pinch to resize (signatures placed on images).
 *  - CropOverlay: iOS-style crop frame with corner handles, dimming and a thirds grid.
 * Both report rectangles in SCREEN points; the editor converts them to document pixels with
 * the canvas transform when the user confirms.
 */
import React, { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function clampRect(r: ScreenRect, bounds: ScreenRect, minSize: number): ScreenRect {
  const width = Math.max(minSize, Math.min(r.width, bounds.width));
  const height = Math.max(minSize, Math.min(r.height, bounds.height));
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, r.x));
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, r.y));
  return { x, y, width, height };
}

export const PlacementBox: React.FC<{
  rect: ScreenRect;
  bounds: ScreenRect;
  color: string;
  onChange: (rect: ScreenRect) => void;
  children?: React.ReactNode;
}> = ({ rect, bounds, color, onChange, children }) => {
  const start = useRef<ScreenRect>(rect);
  const latest = useRef({ rect, bounds, onChange });
  latest.current = { rect, bounds, onChange };

  const begin = () => {
    start.current = latest.current.rect;
  };
  const move = (dx: number, dy: number) => {
    const s = start.current;
    latest.current.onChange(clampRect({ ...s, x: s.x + dx, y: s.y + dy }, latest.current.bounds, 24));
  };
  const scaleBy = (k: number) => {
    const s = start.current;
    const w = s.width * k;
    const h = s.height * k;
    const r = { x: s.x + (s.width - w) / 2, y: s.y + (s.height - h) / 2, width: w, height: h };
    if (w < 24 || h < 24 || w > latest.current.bounds.width || h > latest.current.bounds.height) return;
    latest.current.onChange(clampRect(r, latest.current.bounds, 24));
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onStart(() => {
      'worklet';
      runOnJS(begin)();
    })
    .onUpdate((e) => {
      'worklet';
      runOnJS(move)(e.translationX, e.translationY);
    });
  const pinch = Gesture.Pinch()
    .onStart(() => {
      'worklet';
      runOnJS(begin)();
    })
    .onUpdate((e) => {
      'worklet';
      runOnJS(scaleBy)(e.scale);
    });

  return (
    <GestureDetector gesture={Gesture.Race(pinch, pan)}>
      <View
        accessibilityLabel="Placement. Drag to move, pinch to resize."
        style={[styles.box, { left: rect.x, top: rect.y, width: rect.width, height: rect.height, borderColor: color }]}>
        {children}
        {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
          <View
            key={c}
            pointerEvents="none"
            style={[
              styles.dot,
              { backgroundColor: color },
              c.includes('t') ? { top: -6 } : { bottom: -6 },
              c.includes('l') ? { left: -6 } : { right: -6 },
            ]}
          />
        ))}
      </View>
    </GestureDetector>
  );
};

type Corner = 'tl' | 'tr' | 'bl' | 'br';

export const CropOverlay: React.FC<{
  rect: ScreenRect;
  bounds: ScreenRect;
  /** width / height, or null for free-form. */
  aspect: number | null;
  onChange: (rect: ScreenRect) => void;
}> = ({ rect, bounds, aspect, onChange }) => {
  const start = useRef<ScreenRect>(rect);
  const latest = useRef({ rect, bounds, aspect, onChange });
  latest.current = { rect, bounds, aspect, onChange };
  const MIN = 48;

  const begin = () => {
    start.current = latest.current.rect;
  };

  const moveBody = (dx: number, dy: number) => {
    const s = start.current;
    latest.current.onChange(clampRect({ ...s, x: s.x + dx, y: s.y + dy }, latest.current.bounds, MIN));
  };

  const dragCorner = (corner: Corner, dx: number, dy: number) => {
    const s = start.current;
    const b = latest.current.bounds;
    let left = s.x;
    let top = s.y;
    let right = s.x + s.width;
    let bottom = s.y + s.height;
    if (corner.includes('l')) left = Math.min(right - MIN, Math.max(b.x, left + dx));
    if (corner.includes('r')) right = Math.max(left + MIN, Math.min(b.x + b.width, right + dx));
    if (corner.includes('t')) top = Math.min(bottom - MIN, Math.max(b.y, top + dy));
    if (corner.includes('b')) bottom = Math.max(top + MIN, Math.min(b.y + b.height, bottom + dy));
    let w = right - left;
    let h = bottom - top;
    const a = latest.current.aspect;
    if (a) {
      // Keep the aspect ratio: the larger relative change wins, anchored at the opposite corner.
      if (w / h > a) w = h * a;
      else h = w / a;
      if (corner.includes('l')) left = right - w;
      if (corner.includes('t')) top = bottom - h;
    }
    latest.current.onChange(clampRect({ x: left, y: top, width: w, height: h }, b, MIN));
  };

  const bodyPan = Gesture.Pan()
    .minDistance(0)
    .onStart(() => {
      'worklet';
      runOnJS(begin)();
    })
    .onUpdate((e) => {
      'worklet';
      runOnJS(moveBody)(e.translationX, e.translationY);
    });

  const cornerPan = (corner: Corner) =>
    Gesture.Pan()
      .minDistance(0)
      .onStart(() => {
        'worklet';
        runOnJS(begin)();
      })
      .onUpdate((e) => {
        'worklet';
        runOnJS(dragCorner)(corner, e.translationX, e.translationY);
      });

  const dim = 'rgba(0,0,0,0.55)';
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Dimmed outside area */}
      <View pointerEvents="none" style={[styles.dim, { backgroundColor: dim, left: 0, right: 0, top: 0, height: rect.y }]} />
      <View pointerEvents="none" style={[styles.dim, { backgroundColor: dim, left: 0, right: 0, top: rect.y + rect.height, bottom: 0 }]} />
      <View pointerEvents="none" style={[styles.dim, { backgroundColor: dim, left: 0, width: rect.x, top: rect.y, height: rect.height }]} />
      <View pointerEvents="none" style={[styles.dim, { backgroundColor: dim, left: rect.x + rect.width, right: 0, top: rect.y, height: rect.height }]} />

      <GestureDetector gesture={bodyPan}>
        <View
          accessibilityLabel="Crop area. Drag to move, drag the corners to resize."
          style={[styles.crop, { left: rect.x, top: rect.y, width: rect.width, height: rect.height }]}>
          {/* Rule-of-thirds grid */}
          <View pointerEvents="none" style={[styles.gridV, { left: '33.33%' }]} />
          <View pointerEvents="none" style={[styles.gridV, { left: '66.66%' }]} />
          <View pointerEvents="none" style={[styles.gridH, { top: '33.33%' }]} />
          <View pointerEvents="none" style={[styles.gridH, { top: '66.66%' }]} />
        </View>
      </GestureDetector>

      {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => {
        const cx = corner.includes('l') ? rect.x : rect.x + rect.width;
        const cy = corner.includes('t') ? rect.y : rect.y + rect.height;
        return (
          <GestureDetector key={corner} gesture={cornerPan(corner)}>
            <View style={[styles.cornerHit, { left: cx - 22, top: cy - 22 }]} accessibilityLabel={`Crop corner ${corner}`}>
              <View
                style={[
                  styles.cornerMark,
                  corner.includes('t') ? { top: 19, borderTopWidth: 4 } : { bottom: 19, borderBottomWidth: 4 },
                  corner.includes('l') ? { left: 19, borderLeftWidth: 4 } : { right: 19, borderRightWidth: 4 },
                ]}
              />
            </View>
          </GestureDetector>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  box: { position: 'absolute', borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 4 },
  dot: { position: 'absolute', width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#FFFFFF' },
  dim: { position: 'absolute' },
  crop: { position: 'absolute', borderWidth: 1, borderColor: '#FFFFFF' },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.6)' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.6)' },
  cornerHit: { position: 'absolute', width: 44, height: 44 },
  cornerMark: { position: 'absolute', width: 20, height: 20, borderColor: '#FFFFFF' },
});
