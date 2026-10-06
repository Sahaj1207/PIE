/**
 * PDF page geometry: conversion between PDF user space and the DISPLAYED page.
 *
 * Document coordinates in PIE are display coordinates: points, origin at the top-left of the
 * page as rendered, Y down — the same space as rendered bitmaps, hit-testing, selection and
 * the viewport. PDF content lives in user space (origin at the page box's lower-left, Y up).
 * The page's /Rotate (clockwise quarter turns) and crop-box origin relate the two.
 *
 * The authoritative mapping is reported by the native layer (derived from PDFium's own
 * display transform, see PdfPageSize.displayMatrix). `rotationDisplayMatrix` reproduces it
 * from rotation + box for platforms/tests without that data; unrotated pages map exactly
 * as before (u = x, v = height - y).
 */
import { PdfDisplayMatrix, PdfPageRotation, PdfPageSize, PdfRawBounds, PdfRect, PdfTransformationMatrix } from './types';

export interface UserBox {
  /** Lower-left corner of the page box in user space. */
  readonly left: number;
  readonly bottom: number;
  /** UNROTATED box size in user space. */
  readonly width: number;
  readonly height: number;
}

export function normalizeRotation(value: unknown): PdfPageRotation {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const quarter = (((Math.round(n / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return (quarter * 90) as PdfPageRotation;
}

/**
 * User -> display matrix for a page box rotated clockwise by `rotation` when displayed.
 * u = a*x + c*y + e, v = b*x + d*y + f (display: top-left origin, Y down).
 */
export function rotationDisplayMatrix(rotation: PdfPageRotation, box: UserBox): PdfDisplayMatrix {
  const { left: bx, bottom: by, width: w, height: h } = box;
  switch (rotation) {
    case 90:
      // u = y - by, v = x - bx
      return { a: 0, b: 1, c: 1, d: 0, e: -by, f: -bx };
    case 180:
      // u = w - (x - bx), v = y - by
      return { a: -1, b: 0, c: 0, d: 1, e: w + bx, f: -by };
    case 270:
      // u = h - (y - by), v = w - (x - bx)
      return { a: 0, b: -1, c: -1, d: 0, e: h + by, f: w + bx };
    default:
      // u = x - bx, v = h - (y - by)
      return { a: 1, b: 0, c: 0, d: -1, e: -bx, f: h + by };
  }
}

/** Display matrix of a page: native (PDFium) when reported, else unrotated at origin. */
export function displayMatrixForPage(size: Pick<PdfPageSize, 'width' | 'height' | 'rotation' | 'displayMatrix'>): PdfDisplayMatrix {
  if (size.displayMatrix && isInvertible(size.displayMatrix)) {
    return size.displayMatrix;
  }
  const rotation = normalizeRotation(size.rotation ?? 0);
  const odd = rotation === 90 || rotation === 270;
  // size.width/height are DISPLAY sizes; the unrotated user box swaps them for odd turns.
  const box: UserBox = {
    left: 0,
    bottom: 0,
    width: odd ? size.height : size.width,
    height: odd ? size.width : size.height,
  };
  return rotationDisplayMatrix(rotation, box);
}

function determinant(m: PdfDisplayMatrix): number {
  return m.a * m.d - m.b * m.c;
}

function isInvertible(m: PdfDisplayMatrix): boolean {
  return [m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite) && Math.abs(determinant(m)) > 1e-9;
}

/** Normalizes -0 to 0 (so results compare equal to literal coordinates). */
function noNegZero(v: number): number {
  return v === 0 ? 0 : v;
}

export function userToDisplayPoint(m: PdfDisplayMatrix, x: number, y: number): { x: number; y: number } {
  return { x: noNegZero(m.a * x + m.c * y + m.e), y: noNegZero(m.b * x + m.d * y + m.f) };
}

export function displayToUserPoint(m: PdfDisplayMatrix, u: number, v: number): { x: number; y: number } {
  const det = determinant(m);
  const du = u - m.e;
  const dv = v - m.f;
  return {
    x: noNegZero((m.d * du - m.c * dv) / det),
    y: noNegZero((-m.b * du + m.a * dv) / det),
  };
}

/** User-space bounds -> display rect (top-left origin). */
export function userBoundsToDisplayRect(m: PdfDisplayMatrix, raw: PdfRawBounds): PdfRect {
  const corners = [
    userToDisplayPoint(m, raw.left, raw.bottom),
    userToDisplayPoint(m, raw.left, raw.top),
    userToDisplayPoint(m, raw.right, raw.bottom),
    userToDisplayPoint(m, raw.right, raw.top),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Display rect -> user-space bounds. */
export function displayRectToUserBounds(m: PdfDisplayMatrix, rect: PdfRect): PdfRawBounds {
  const corners = [
    displayToUserPoint(m, rect.x, rect.y),
    displayToUserPoint(m, rect.x + rect.width, rect.y),
    displayToUserPoint(m, rect.x, rect.y + rect.height),
    displayToUserPoint(m, rect.x + rect.width, rect.y + rect.height),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
}

/**
 * Text object matrix whose text reads upright left-to-right in the displayed page, with its
 * baseline origin at user point (x, y). Identity basis for unrotated pages. Mirrors
 * uprightTextBasis() in pdfium_bridge.cpp.
 */
export function uprightTextMatrix(m: PdfDisplayMatrix, x: number, y: number): PdfTransformationMatrix {
  const det = determinant(m);
  if (Math.abs(det) < 1e-9) {
    return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
  }
  const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : noNegZero(v));
  return {
    a: clean(m.d / det),
    b: clean(-m.b / det),
    c: clean(m.c / det),
    d: clean(-m.a / det),
    e: x,
    f: y,
  };
}

/**
 * Inserted text placement: the tapped/top-left display point and font size -> the user-space
 * baseline origin (display baseline = top + fontSize), the upright text matrix and the
 * object's user bounds (a box of boxSize standing on the baseline). For unrotated pages this
 * is exactly the previous convention: pdfX = x, pdfY = height - (y + fontSize),
 * pdfBounds = { left: pdfX, bottom: pdfY, right: pdfX + w, top: pdfY + h }.
 */
export function placeInsertedText(
  size: Pick<PdfPageSize, 'width' | 'height' | 'rotation' | 'displayMatrix'>,
  displayTopLeft: { x: number; y: number },
  fontSize: number,
  boxSize: { width: number; height: number },
): { pdfX: number; pdfY: number; matrix: PdfTransformationMatrix; pdfBounds: PdfRawBounds } {
  const m = displayMatrixForPage(size);
  const baselineV = displayTopLeft.y + fontSize;
  const baseline = displayToUserPoint(m, displayTopLeft.x, baselineV);
  return {
    pdfX: baseline.x,
    pdfY: baseline.y,
    matrix: uprightTextMatrix(m, baseline.x, baseline.y),
    pdfBounds: displayRectToUserBounds(m, {
      x: displayTopLeft.x,
      y: baselineV - boxSize.height,
      width: boxSize.width,
      height: boxSize.height,
    }),
  };
}
