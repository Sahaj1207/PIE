/**
 * Markup geometry shared by the PDF editor (sent to PDFium as page content) and the image
 * editor (drawn by Skia, exported by the native image exporter): the SAME path commands are
 * used everywhere, so what the user sees is what is written.
 *
 * Commands use one coordinate space chosen by the caller (PDF display points or image pixels):
 *   ['M', x, y]  ['L', x, y]  ['Q', cx, cy, x, y]  ['C', x1, y1, x2, y2, x, y]  ['Z']
 */

export type PathCommand =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['Q', number, number, number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Drops points closer than `minDistance` to the previous kept point (keeps the last point). */
export function simplifyPoints(points: readonly Point[], minDistance: number): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDistance) out.push(p);
  }
  const final = points[points.length - 1];
  if (final && out.length > 0 && out[out.length - 1] !== final && Number.isFinite(final.x) && Number.isFinite(final.y)) {
    const last = out[out.length - 1];
    if (last.x !== final.x || last.y !== final.y) out.push(final);
  }
  return out;
}

/**
 * Smooth stroke through the sampled points: quadratic curves through segment midpoints
 * (a standard, deterministic finger-ink smoothing). A single point becomes a dot.
 */
export function smoothStroke(points: readonly Point[], minDistance = 0.75): PathCommand[] {
  const pts = simplifyPoints(points, minDistance);
  if (pts.length === 0) return [];
  if (pts.length === 1) {
    const p = pts[0];
    return [['M', round(p.x), round(p.y)], ['L', round(p.x + 0.01), round(p.y + 0.01)]];
  }
  if (pts.length === 2) {
    return [['M', round(pts[0].x), round(pts[0].y)], ['L', round(pts[1].x), round(pts[1].y)]];
  }
  const cmds: PathCommand[] = [['M', round(pts[0].x), round(pts[0].y)]];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    cmds.push(['Q', round(pts[i].x), round(pts[i].y), round(mid.x), round(mid.y)]);
  }
  const last = pts[pts.length - 1];
  cmds.push(['L', round(last.x), round(last.y)]);
  return cmds;
}

/** SVG path string for Skia. */
export function commandsToSvg(cmds: readonly PathCommand[]): string {
  return cmds
    .map((c) => (c[0] === 'Z' ? 'Z' : `${c[0]}${c.slice(1).join(' ')}`))
    .join(' ');
}

/** Applies a point transform to every coordinate pair. */
export function transformCommands(cmds: readonly PathCommand[], fn: (p: Point) => Point): PathCommand[] {
  return cmds.map((c): PathCommand => {
    switch (c[0]) {
      case 'M':
      case 'L': {
        const p = fn({ x: c[1], y: c[2] });
        return [c[0], round(p.x), round(p.y)];
      }
      case 'Q': {
        const a = fn({ x: c[1], y: c[2] });
        const b = fn({ x: c[3], y: c[4] });
        return ['Q', round(a.x), round(a.y), round(b.x), round(b.y)];
      }
      case 'C': {
        const a = fn({ x: c[1], y: c[2] });
        const b = fn({ x: c[3], y: c[4] });
        const d = fn({ x: c[5], y: c[6] });
        return ['C', round(a.x), round(a.y), round(b.x), round(b.y), round(d.x), round(d.y)];
      }
      default:
        return ['Z'];
    }
  });
}

/** Bounding box of all coordinates (control points included; conservative). */
export function commandsBounds(strokes: readonly (readonly PathCommand[])[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cmds of strokes) {
    for (const c of cmds) {
      for (let i = 1; i + 1 < c.length; i += 2) {
        const x = c[i] as number;
        const y = c[i + 1] as number;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Maps strokes from their own bounds into `target` (uniform scale, centred). */
export function fitStrokesInto(
  strokes: readonly (readonly PathCommand[])[],
  target: Bounds,
): PathCommand[][] {
  const b = commandsBounds(strokes);
  if (!b) return [];
  const s = Math.min(target.width / Math.max(b.width, 1e-6), target.height / Math.max(b.height, 1e-6));
  const scale = Number.isFinite(s) && s > 0 ? s : 1;
  const ox = target.x + (target.width - b.width * scale) / 2;
  const oy = target.y + (target.height - b.height * scale) / 2;
  return strokes.map((cmds) =>
    transformCommands(cmds, (p) => ({ x: ox + (p.x - b.x) * scale, y: oy + (p.y - b.y) * scale })),
  );
}

/** Shape outlines in the same command form (used for previews and image export). */
export function rectCommands(r: Bounds): PathCommand[] {
  return [
    ['M', r.x, r.y],
    ['L', r.x + r.width, r.y],
    ['L', r.x + r.width, r.y + r.height],
    ['L', r.x, r.y + r.height],
    ['Z'],
  ];
}

export function ellipseCommands(r: Bounds): PathCommand[] {
  const k = 0.5522847498;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const rx = r.width / 2;
  const ry = r.height / 2;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
    ['C', cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
    ['C', cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
    ['C', cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy],
    ['Z'],
  ];
}

/** Line from (x, y) to (x + width, y + height); `arrow` adds a head at the end. */
export function lineCommands(r: Bounds, arrow: boolean, strokeWidth: number): PathCommand[] {
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  const cmds: PathCommand[] = [['M', r.x, r.y], ['L', x2, y2]];
  if (arrow && Math.hypot(r.width, r.height) > 0.001) {
    const head = Math.max(6, strokeWidth * 4);
    const ang = Math.atan2(r.height, r.width);
    cmds.push(
      ['M', x2 + head * Math.cos(ang + 2.6), y2 + head * Math.sin(ang + 2.6)],
      ['L', x2, y2],
      ['L', x2 + head * Math.cos(ang - 2.6), y2 + head * Math.sin(ang - 2.6)],
    );
  }
  return cmds;
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';

export function shapeCommands(shape: ShapeKind, r: Bounds, strokeWidth: number): PathCommand[] {
  switch (shape) {
    case 'rect':
      return rectCommands(normalizeRect(r));
    case 'ellipse':
      return ellipseCommands(normalizeRect(r));
    case 'line':
      return lineCommands(r, false, strokeWidth);
    case 'arrow':
      return lineCommands(r, true, strokeWidth);
  }
}

/** Rect with non-negative width/height (drag in any direction). */
export function normalizeRect(r: Bounds): Bounds {
  return {
    x: Math.min(r.x, r.x + r.width),
    y: Math.min(r.y, r.y + r.height),
    width: Math.abs(r.width),
    height: Math.abs(r.height),
  };
}
