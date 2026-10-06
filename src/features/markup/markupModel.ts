/**
 * Markup tool state shared by the PDF and image editors (pen, highlighter, shapes) and the
 * conversion of finished strokes/shapes into concrete drawings.
 */
import { Bounds, PathCommand, Point, ShapeKind, normalizeRect, shapeCommands, smoothStroke } from './inkPath';

export type MarkupTool = 'pen' | 'highlighter' | 'eraser' | ShapeKind;

export const MARKUP_COLORS: readonly string[] = [
  '#000000',
  '#FFFFFF',
  '#007AFF',
  '#FF3B30',
  '#34C759',
  '#FFCC00',
  '#FF9500',
  '#AF52DE',
];

export const HIGHLIGHTER_COLORS: readonly string[] = ['#FFE066', '#7CF29A', '#7FD4FF', '#FF9ECF', '#FFB37A'];

/** Stroke widths offered (page points for PDFs; scaled for images). */
export const MARKUP_WIDTHS: readonly number[] = [1.5, 3, 6];
export const HIGHLIGHTER_WIDTH_FACTOR = 4;
export const HIGHLIGHTER_OPACITY = 0.4;

export interface MarkupStyle {
  readonly color: string;
  readonly width: number;
}

/** One finished drawing in document space. */
export interface MarkupDrawing {
  readonly id: string;
  readonly kind: 'ink' | 'highlighter' | 'shape';
  readonly shape?: ShapeKind;
  /** Shape geometry (line/arrow: start + delta). */
  readonly rect?: Bounds;
  readonly commands: readonly PathCommand[];
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
}

let seq = 0;
export function nextDrawingId(prefix = 'm'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

export function isShapeTool(tool: MarkupTool): tool is ShapeKind {
  return tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow';
}

/** Turns sampled points of a gesture into a drawing for the active tool (null if too small). */
export function drawingFromGesture(
  tool: MarkupTool,
  points: readonly Point[],
  style: MarkupStyle,
  minExtent: number,
): MarkupDrawing | null {
  if (points.length === 0 || tool === 'eraser') return null;
  if (isShapeTool(tool)) {
    const a = points[0];
    const b = points[points.length - 1];
    const raw: Bounds = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    if (Math.hypot(raw.width, raw.height) < minExtent) return null;
    const rect = tool === 'line' || tool === 'arrow' ? raw : normalizeRect(raw);
    return {
      id: nextDrawingId(),
      kind: 'shape',
      shape: tool,
      rect,
      commands: shapeCommands(tool, rect, style.width),
      color: style.color,
      width: style.width,
      opacity: 1,
    };
  }
  const commands = smoothStroke(points, Math.max(0.3, style.width * 0.15));
  if (commands.length === 0) return null;
  const highlighter = tool === 'highlighter';
  return {
    id: nextDrawingId(),
    kind: highlighter ? 'highlighter' : 'ink',
    commands,
    color: style.color,
    width: highlighter ? style.width * HIGHLIGHTER_WIDTH_FACTOR : style.width,
    opacity: highlighter ? HIGHLIGHTER_OPACITY : 1,
  };
}

/** Live preview while the finger is down (same geometry as the finished drawing). */
export function previewCommands(tool: MarkupTool, points: readonly Point[], width: number): PathCommand[] {
  if (points.length === 0) return [];
  if (isShapeTool(tool)) {
    const a = points[0];
    const b = points[points.length - 1];
    const raw: Bounds = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    return shapeCommands(tool, tool === 'line' || tool === 'arrow' ? raw : normalizeRect(raw), width);
  }
  return smoothStroke(points, 0.3);
}
