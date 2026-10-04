import { DocumentRect } from '../../types/geometry';

export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

export interface ReconstructionAnalysis {
  readonly estimatedBackgroundColor: string;
  readonly estimatedTextColor: string;
  readonly isGradient: boolean;
  readonly confidence: number;
}

export interface PixelGrid {
  readonly width: number;
  readonly height: number;
  getPixel(x: number, y: number): RGBColor;
  setPixel(x: number, y: number, color: RGBColor): void;
}

/**
 * Expands a bounding box by a given padding, clamping strictly within image dimensions.
 */
export function expandBoundingBox(
  box: DocumentRect,
  padding: number,
  imageBounds: { width: number; height: number },
): DocumentRect {
  const pad = Math.max(0, Math.round(padding));
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const right = Math.min(imageBounds.width, Math.ceil(box.x + box.width + pad));
  const bottom = Math.min(imageBounds.height, Math.ceil(box.y + box.height + pad));

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

export function rgbToHex(c: RGBColor): string {
  const r = Math.max(0, Math.min(255, Math.round(c.r))).toString(16).padStart(2, '0');
  const g = Math.max(0, Math.min(255, Math.round(c.g))).toString(16).padStart(2, '0');
  const b = Math.max(0, Math.min(255, Math.round(c.b))).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`.toUpperCase();
}

export function hexToRgb(hex: string): RGBColor {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16) || 0,
      g: parseInt(clean[1] + clean[1], 16) || 0,
      b: parseInt(clean[2] + clean[2], 16) || 0,
    };
  }
  return {
    r: parseInt(clean.substring(0, 2), 16) || 0,
    g: parseInt(clean.substring(2, 4), 16) || 0,
    b: parseInt(clean.substring(4, 6), 16) || 0,
  };
}

export function colorDistance(c1: RGBColor, c2: RGBColor): number {
  const dr = c1.r - c2.r;
  const dg = c1.g - c2.g;
  const db = c1.b - c2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export interface BorderSample {
  x: number;
  y: number;
  color: RGBColor;
}

/**
 * Samples perimeter pixels around an inner bounding box within an expanded region.
 */
export function sampleBorderPixels(
  grid: PixelGrid,
  innerBox: DocumentRect,
  borderThickness: number = 3,
): BorderSample[] {
  const samples: BorderSample[] = [];
  const thickness = Math.max(1, Math.round(borderThickness));

  const minX = Math.max(0, Math.floor(innerBox.x - thickness));
  const maxX = Math.min(grid.width - 1, Math.ceil(innerBox.x + innerBox.width + thickness - 1));
  const minY = Math.max(0, Math.floor(innerBox.y - thickness));
  const maxY = Math.min(grid.height - 1, Math.ceil(innerBox.y + innerBox.height + thickness - 1));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const isInsideInner =
        x >= innerBox.x &&
        x < innerBox.x + innerBox.width &&
        y >= innerBox.y &&
        y < innerBox.y + innerBox.height;

      if (!isInsideInner) {
        samples.push({
          x,
          y,
          color: grid.getPixel(x, y),
        });
      }
    }
  }

  return samples;
}

/**
 * Fits a 2D linear gradient C(x, y) = C0 + a*x + b*y to border samples.
 */
export function fitLinearGradient(samples: BorderSample[]): {
  predict: (x: number, y: number) => RGBColor;
  meanColor: RGBColor;
  variance: number;
} {
  if (samples.length === 0) {
    const fallback = { r: 255, g: 255, b: 255 };
    return {
      predict: () => fallback,
      meanColor: fallback,
      variance: 0,
    };
  }

  let sumR = 0, sumG = 0, sumB = 0;
  let sumX = 0, sumY = 0;
  let sumXX = 0, sumYY = 0, sumXY = 0;
  let sumXR = 0, sumYR = 0;
  let sumXG = 0, sumYG = 0;
  let sumXB = 0, sumYB = 0;

  const n = samples.length;
  for (const s of samples) {
    sumR += s.color.r;
    sumG += s.color.g;
    sumB += s.color.b;
    sumX += s.x;
    sumY += s.y;
    sumXX += s.x * s.x;
    sumYY += s.y * s.y;
    sumXY += s.x * s.y;
    sumXR += s.x * s.color.r;
    sumYR += s.y * s.color.r;
    sumXG += s.x * s.color.g;
    sumYG += s.y * s.color.g;
    sumXB += s.x * s.color.b;
    sumYB += s.y * s.color.b;
  }

  const meanColor: RGBColor = {
    r: sumR / n,
    g: sumG / n,
    b: sumB / n,
  };

  // Compute variance
  let varSum = 0;
  for (const s of samples) {
    const d = colorDistance(s.color, meanColor);
    varSum += d * d;
  }
  const variance = varSum / n;

  // Solve 3x3 normal equations for least squares plane fit
  // [ n    sumX  sumY  ] [ c0 ]   [ sumC  ]
  // [ sumX sumXX sumXY ] [ a  ] = [ sumXC ]
  // [ sumY sumXY sumYY ] [ b  ]   [ sumYC ]
  function solvePlane(sumC: number, sumXC: number, sumYC: number): { c0: number; a: number; b: number } {
    const det =
      n * (sumXX * sumYY - sumXY * sumXY) -
      sumX * (sumX * sumYY - sumXY * sumY) +
      sumY * (sumX * sumXY - sumXX * sumY);

    if (Math.abs(det) < 1e-6) {
      return { c0: sumC / n, a: 0, b: 0 };
    }

    const detC0 =
      sumC * (sumXX * sumYY - sumXY * sumXY) -
      sumX * (sumXC * sumYY - sumXY * sumYC) +
      sumY * (sumXC * sumXY - sumXX * sumYC);

    const detA =
      n * (sumXC * sumYY - sumXY * sumYC) -
      sumC * (sumX * sumYY - sumXY * sumY) +
      sumY * (sumX * sumYC - sumXC * sumY);

    const detB =
      n * (sumXX * sumYC - sumXC * sumXY) -
      sumX * (sumX * sumYC - sumXC * sumY) +
      sumC * (sumX * sumXY - sumXX * sumY);

    return {
      c0: detC0 / det,
      a: detA / det,
      b: detB / det,
    };
  }

  const fitR = solvePlane(sumR, sumXR, sumYR);
  const fitG = solvePlane(sumG, sumXG, sumYG);
  const fitB = solvePlane(sumB, sumXB, sumYB);

  const predict = (x: number, y: number): RGBColor => {
    return {
      r: Math.max(0, Math.min(255, Math.round(fitR.c0 + fitR.a * x + fitR.b * y))),
      g: Math.max(0, Math.min(255, Math.round(fitG.c0 + fitG.a * x + fitG.b * y))),
      b: Math.max(0, Math.min(255, Math.round(fitB.c0 + fitB.a * x + fitB.b * y))),
    };
  };

  return { predict, meanColor, variance };
}

/**
 * Reconstructs target pixels in the grid by interpolating surrounding border pixels.
 * Uses 2D gradient regression with inverse-distance weighting blending.
 */
export function reconstructGridRegion(
  grid: PixelGrid,
  targetBox: DocumentRect,
  borderThickness: number = 4,
): ReconstructionAnalysis {
  const borderSamples = sampleBorderPixels(grid, targetBox, borderThickness);
  const { predict, meanColor, variance } = fitLinearGradient(borderSamples);

  // Analyze text color inside original box by contrast against background
  let textSampleCount = 0;
  let textSumR = 0, textSumG = 0, textSumB = 0;

  const minX = Math.max(0, Math.floor(targetBox.x));
  const maxX = Math.min(grid.width - 1, Math.ceil(targetBox.x + targetBox.width - 1));
  const minY = Math.max(0, Math.floor(targetBox.y));
  const maxY = Math.min(grid.height - 1, Math.ceil(targetBox.y + targetBox.height - 1));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const original = grid.getPixel(x, y);
      const bgEstimate = predict(x, y);
      if (colorDistance(original, bgEstimate) > 35) {
        textSumR += original.r;
        textSumG += original.g;
        textSumB += original.b;
        textSampleCount++;
      }
    }
  }

  let estimatedTextColor: string;
  if (textSampleCount > 0) {
    estimatedTextColor = rgbToHex({
      r: textSumR / textSampleCount,
      g: textSumG / textSampleCount,
      b: textSumB / textSampleCount,
    });
  } else {
    // Default high contrast relative to estimated background
    const bgLuminance = 0.299 * meanColor.r + 0.587 * meanColor.g + 0.114 * meanColor.b;
    estimatedTextColor = bgLuminance > 128 ? '#111827' : '#F9FAFB';
  }

  // Perform deterministic reconstruction on the target box
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const reconstructed = predict(x, y);
      grid.setPixel(x, y, reconstructed);
    }
  }

  const isGradient = variance > 25;
  const confidence = Math.max(0.6, Math.min(0.98, 1.0 - variance / 1000));

  return {
    estimatedBackgroundColor: rgbToHex(meanColor),
    estimatedTextColor,
    isGradient,
    confidence,
  };
}
