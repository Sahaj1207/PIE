/**
 * Core geometric types and coordinates.
 *
 * CRITICAL ARCHITECTURAL PRINCIPLE:
 * Document coordinates are completely decoupled from device screen coordinates.
 * Document coordinates represent the intrinsic coordinate space of the page (e.g. PDF points or original image pixels).
 * Viewport / Screen coordinates represent the rendered pixel position on the physical device display.
 */

export interface DocumentPoint {
  readonly x: number;
  readonly y: number;
}

export interface DocumentSize {
  readonly width: number;
  readonly height: number;
}

export interface DocumentRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewportOrigin {
  readonly x: number;
  readonly y: number;
}

export interface DocumentViewportLayout {
  /** Base scale applied to document to fit in viewport (1.0 for 1:1 image canvas) */
  readonly baseScale: number;
  /** Document origin X offset inside viewport (centering offset) */
  readonly originX: number;
  /** Document origin Y offset inside viewport (centering offset) */
  readonly originY: number;
}

export interface ViewportTransform {
  /** Zoom scale factor (1.0 = 100% document scale) */
  readonly scale: number;
  /** Translation along X axis on the screen */
  readonly translateX: number;
  /** Translation along Y axis on the screen */
  readonly translateY: number;
}
