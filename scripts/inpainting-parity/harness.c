#include "../../ios/PieNative/PieTextInpainting.h"

#define W 72
#define H 40
static uint8_t img[W * H * 4];
static uint8_t patch[64 * 32 * 4];
static uint8_t scratch[W * H * 112 + 1024];
static PieInpaintResult result;

static void set(int x, int y, int r, int g, int b) {
  uint8_t *p = img + (y * W + x) * 4;
  p[0] = (uint8_t)r; p[1] = (uint8_t)g; p[2] = (uint8_t)b; p[3] = 255;
}
static void paint(int x0, int y0, int ww, int hh, int r, int g, int b) {
  for (int y = y0; y < y0 + hh; y++) for (int x = x0; x < x0 + ww; x++) set(x, y, r, g, b);
}

// caseId: 0 flat, 1 stripes, 2 gradient, 3 noise, 4 blank
int run(int caseId) {
  for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
    switch (caseId) {
      case 0: set(x, y, 250, 250, 250); break;
      case 1: if ((x / 2) % 2 == 0) set(x, y, 200, 180, 150); else set(x, y, 230, 210, 180); break;
      case 2: set(x, y, 100 + x * 2, 80 + y, 160); break;
      case 3: set(x, y, (x * 7 + y * 3) % 60 + 150, (x * 13 + y * 5) % 40 + 160, (x * 3 + y * 11) % 50 + 140); break;
      default: set(x, y, 240, 240, 240); break;
    }
  }
  int c0 = 10, c1 = 10, c2 = 10;
  if (caseId == 2) { c0 = c1 = c2 = 250; }
  if (caseId == 3) { c0 = 30; c1 = 40; c2 = 50; }
  if (caseId != 4) {
    paint(14, 12, 3, 16, c0, c1, c2); paint(14, 26, 10, 2, c0, c1, c2);
    paint(30, 12, 3, 16, c0, c1, c2); paint(30, 12, 10, 2, c0, c1, c2);
    paint(46, 12, 3, 16, c0, c1, c2); paint(52, 12, 3, 16, c0, c1, c2);
  } else {
    paint(30, 15, 1, 1, 235, 235, 235);
  }
  if (PieInpaintScratchSize(W, H) > sizeof(scratch)) return -2;
  return PieReconstructTextPatch(img, W, H, 4, 4, 64, 32, 9, 9, 54, 22, patch, scratch, &result);
}

uint8_t *patchPtr(void) { return patch; }
PieInpaintResult *resultPtr(void) { return &result; }
