import { PdfTransformationMatrix } from './types';

export function composePdfMatrices(
  outer: PdfTransformationMatrix,
  inner: PdfTransformationMatrix,
): PdfTransformationMatrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function pdfObjectPathId(pageIndex: number, path: readonly number[]): string {
  return `p${pageIndex}_path${path.join('_')}`;
}
