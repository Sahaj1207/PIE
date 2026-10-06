/**
 * Maximum decoded pixel count accepted for an image document. Keeps full-resolution
 * reconstruction and export within on-device memory limits (50 MP ≈ 200 MB ARGB_8888).
 */
export const MAX_IMAGE_PIXELS = 50_000_000;

/** Longest side (px) of the downsampled display preview generated at import. */
export const PREVIEW_MAX_DIMENSION = 4096;
