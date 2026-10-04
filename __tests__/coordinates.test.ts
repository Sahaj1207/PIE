import {
  documentToScreenPoint,
  screenToDocumentPoint,
  documentToScreenRect,
  screenToDocumentRect,
  rectContainsPoint,
  rectsIntersect,
  clamp,
} from '../src/utils/coordinates';
import { ViewportTransform } from '../src/types/geometry';

describe('Coordinate Transformations', () => {
  const transform: ViewportTransform = {
    scale: 2.0,
    translateX: 50,
    translateY: 100,
  };

  test('converts document point to screen point correctly', () => {
    const docPoint = { x: 10, y: 20 };
    const screenPoint = documentToScreenPoint(docPoint, transform);
    expect(screenPoint).toEqual({
      x: 10 * 2.0 + 50, // 70
      y: 20 * 2.0 + 100, // 140
    });
  });

  test('converts screen point back to document point (round-trip)', () => {
    const screenPoint = { x: 70, y: 140 };
    const docPoint = screenToDocumentPoint(screenPoint, transform);
    expect(docPoint).toEqual({
      x: 10,
      y: 20,
    });
  });

  test('throws error if scale is zero in screenToDocumentPoint', () => {
    const invalidTransform: ViewportTransform = {
      scale: 0,
      translateX: 0,
      translateY: 0,
    };
    expect(() =>
      screenToDocumentPoint({ x: 10, y: 10 }, invalidTransform),
    ).toThrow('Transform scale cannot be zero');
  });

  test('transforms document rect to screen rect', () => {
    const docRect = { x: 10, y: 20, width: 100, height: 50 };
    const screenRect = documentToScreenRect(docRect, transform);
    expect(screenRect).toEqual({
      x: 70,
      y: 140,
      width: 200,
      height: 100,
    });
  });

  test('transforms screen rect back to document rect', () => {
    const screenRect = { x: 70, y: 140, width: 200, height: 100 };
    const docRect = screenToDocumentRect(screenRect, transform);
    expect(docRect).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  test('rectContainsPoint evaluates point containment', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    expect(rectContainsPoint(rect, { x: 50, y: 50 })).toBe(true);
    expect(rectContainsPoint(rect, { x: 0, y: 0 })).toBe(true);
    expect(rectContainsPoint(rect, { x: 100, y: 100 })).toBe(true);
    expect(rectContainsPoint(rect, { x: 101, y: 50 })).toBe(false);
    expect(rectContainsPoint(rect, { x: -1, y: 50 })).toBe(false);
  });

  test('rectsIntersect detects rectangle intersections', () => {
    const a = { x: 0, y: 0, width: 50, height: 50 };
    const b = { x: 25, y: 25, width: 50, height: 50 };
    const c = { x: 100, y: 100, width: 50, height: 50 };

    expect(rectsIntersect(a, b)).toBe(true);
    expect(rectsIntersect(a, c)).toBe(false);
  });

  test('clamp bounds values between min and max', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
