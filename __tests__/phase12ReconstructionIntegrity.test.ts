/**
 * Phase 12 — image background reconstruction never reports a fake success.
 */
import { NativeModules } from 'react-native';
import { LocalBackgroundReconstructionEngine } from '../src/features/image/reconstructionEngine';
import {
  AppError,
  BackgroundReconstructionError,
  ImageReconstructionUnavailableError,
} from '../src/errors';

const REGION = { x: 100, y: 120, width: 300, height: 40 };

describe('Phase 12 — reconstruction integrity', () => {
  const originalEnv = process.env.NODE_ENV;
  let engine: LocalBackgroundReconstructionEngine;

  beforeEach(() => {
    engine = new LocalBackgroundReconstructionEngine();
    delete (NativeModules as any).ImageProcessingModule;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    delete (NativeModules as any).ImageProcessingModule;
  });

  it('fails with a typed error when the native processor is unavailable outside tests', async () => {
    process.env.NODE_ENV = 'production';
    const attempt = engine.reconstructBackground('file:///app/working.jpg', REGION);
    await expect(attempt).rejects.toBeInstanceOf(ImageReconstructionUnavailableError);
    await expect(
      engine.reconstructBackground('file:///app/working.jpg', REGION),
    ).rejects.toBeInstanceOf(BackgroundReconstructionError);
    try {
      await engine.reconstructBackground('file:///app/working.jpg', REGION);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('IMAGE_RECONSTRUCTION_UNAVAILABLE');
    }
  });

  it('never returns an empty/simulated patch in production even when the module lacks the method', async () => {
    process.env.NODE_ENV = 'production';
    (NativeModules as any).ImageProcessingModule = { exportImagePage: jest.fn() };
    await expect(engine.reconstructBackground('file:///app/working.jpg', REGION)).rejects.toBeInstanceOf(
      ImageReconstructionUnavailableError,
    );
  });

  it('rejects a native result without a patch file (would be a silent no-op edit)', async () => {
    (NativeModules as any).ImageProcessingModule = {
      reconstructBackground: jest.fn().mockResolvedValue({
        patchUri: '',
        bounds: { x: 96, y: 116, width: 308, height: 48 },
      }),
    };
    await expect(engine.reconstructBackground('file:///app/working.jpg', REGION)).rejects.toThrow(
      'returned no patch image',
    );
  });

  it('rejects a native result with empty or invalid bounds', async () => {
    (NativeModules as any).ImageProcessingModule = {
      reconstructBackground: jest.fn().mockResolvedValue({
        patchUri: 'file:///cache/patch.png',
        bounds: { x: 0, y: 0, width: 0, height: 10 },
      }),
    };
    await expect(engine.reconstructBackground('file:///app/working.jpg', REGION)).rejects.toBeInstanceOf(
      BackgroundReconstructionError,
    );

    (NativeModules as any).ImageProcessingModule = {
      reconstructBackground: jest.fn().mockResolvedValue({ patchUri: 'file:///cache/patch.png' }),
    };
    await expect(engine.reconstructBackground('file:///app/working.jpg', REGION)).rejects.toThrow(
      'invalid patch bounds',
    );
  });

  it('wraps native exceptions in a typed reconstruction error', async () => {
    (NativeModules as any).ImageProcessingModule = {
      reconstructBackground: jest.fn().mockRejectedValue(new Error('decode failed')),
    };
    await expect(engine.reconstructBackground('file:///app/working.jpg', REGION)).rejects.toThrow(
      'Native background reconstruction failed: decode failed',
    );
  });

  it('preserves the real native path (directory-aware call) and its result', async () => {
    process.env.NODE_ENV = 'production';
    const toDir = jest.fn().mockResolvedValue({
      patchUri: 'file:///data/files/pie/sessions/doc-1/patches/patch_1.png',
      bounds: { x: 96, y: 116, width: 308, height: 48 },
      estimatedBackgroundColor: '#FFFFFF',
      estimatedTextColor: '#111111',
      confidence: 0.93,
    });
    (NativeModules as any).ImageProcessingModule = {
      reconstructBackground: jest.fn(),
      reconstructBackgroundToDirectory: toDir,
    };
    const result = await engine.reconstructBackground('file:///app/working.jpg', REGION, {
      outputDir: '/data/files/pie/sessions/doc-1/patches',
    });
    expect(toDir).toHaveBeenCalledWith(
      'file:///app/working.jpg', 100, 120, 300, 40, '/data/files/pie/sessions/doc-1/patches',
    );
    expect(result).toEqual({
      patchUri: 'file:///data/files/pie/sessions/doc-1/patches/patch_1.png',
      bounds: { x: 96, y: 116, width: 308, height: 48 },
      estimatedBackgroundColor: '#FFFFFF',
      estimatedTextColor: '#111111',
      confidence: 0.93,
    });
  });

  it('keeps the simulated result strictly inside the Jest test environment', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const result = await engine.reconstructBackground('file:///app/working.jpg', REGION);
    expect(result.bounds.width).toBeGreaterThan(0);
  });
});
