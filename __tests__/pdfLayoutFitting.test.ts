import { calculatePdfTextFit } from '../src/features/pdf/pdfLayoutFitting';

describe('PDF Layout & Conservative Text Fitting (Phase 3D)', () => {
  const originalBounds = { x: 50, y: 100, width: 200, height: 30 };

  test('preserves original font size when replacement is shorter or similar length', () => {
    const originalText = 'Section 3.1: Overview';
    const newText = 'Section 3.1: Summary';
    const originalFontSize = 16;

    const fit = calculatePdfTextFit(originalBounds, originalText, newText, originalFontSize);

    expect(fit.strategy).toBe('PRESERVED');
    expect(fit.scaleFactor).toBe(1.0);
    expect(fit.fittedFontSize).toBe(originalFontSize);
    expect(fit.isOverflowing).toBe(false);
  });

  test('conservatively scales down font size when replacement is significantly longer', () => {
    const originalText = 'Short Title';
    const newText = 'A Much Longer Replacement Title That Exceeds Original Bounds';
    const originalFontSize = 20;

    const fit = calculatePdfTextFit(originalBounds, originalText, newText, originalFontSize);

    expect(fit.strategy).toBe('SCALED_DOWN');
    expect(fit.scaleFactor).toBeLessThan(1.0);
    expect(fit.scaleFactor).toBeGreaterThanOrEqual(0.70); // Enforces 70% conservative floor
    expect(fit.fittedFontSize).toBeLessThan(originalFontSize);
    expect(fit.fittedFontSize).toBeGreaterThanOrEqual(14); // 20 * 0.70 = 14
  });

  test('enforces conservative scale floor of 70% for extremely long text', () => {
    const originalText = 'Brief';
    const newText = 'This is an exceedingly long paragraph that would otherwise shrink font size down to illegible microprint';
    const originalFontSize = 18;

    const fit = calculatePdfTextFit(originalBounds, originalText, newText, originalFontSize);

    expect(fit.strategy).toBe('SCALED_DOWN');
    expect(fit.scaleFactor).toBe(0.70);
    expect(fit.fittedFontSize).toBe(Math.round(18 * 0.70 * 10) / 10);
    expect(fit.isOverflowing).toBe(true);
  });

  test('handles empty or whitespace strings gracefully without divide by zero', () => {
    const fit = calculatePdfTextFit(originalBounds, '', 'Some New Text', 12);
    expect(fit.fittedFontSize).toBeDefined();
    expect(fit.fittedFontSize).toBeGreaterThan(0);
  });
});
