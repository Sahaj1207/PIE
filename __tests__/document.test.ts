import { Document, DocumentPage, TextRegion } from '../src/types/document';

describe('Document Model Structure', () => {
  test('creates a valid Document instance with pages and text regions', () => {
    const region: TextRegion = {
      id: 'region-1',
      pageIndex: 0,
      bounds: { x: 20, y: 50, width: 200, height: 24 },
      originalText: 'Original Heading',
      currentText: 'Modified Heading',
      status: 'modified',
      style: {
        fontSize: 18,
        color: '#000000',
        fontWeight: 'bold',
      },
      confidence: 0.98,
    };

    const page: DocumentPage = {
      id: 'page-1',
      pageIndex: 0,
      dimensions: { width: 595, height: 842 },
      rotation: 0,
      originalContent: {
        pageIndex: 0,
        width: 1190,
        height: 1684,
        dpi: 144,
      },
      editableTextRegions: [region],
      addedText: [],
    };

    const doc: Document = {
      id: 'doc-123',
      metadata: {
        id: 'doc-123',
        title: 'Sample Document',
        kind: 'pdf',
        sourceUri: 'file:///sample.pdf',
        pageCount: 1,
        createdAt: 1710000000000,
        updatedAt: 1710000000000,
      },
      pages: [page],
    };

    expect(doc.id).toBe('doc-123');
    expect(doc.pages.length).toBe(1);
    expect(doc.pages[0].editableTextRegions[0].currentText).toBe('Modified Heading');
    expect(doc.pages[0].editableTextRegions[0].status).toBe('modified');
    expect(doc.pages[0].dimensions.width).toBe(595);
    expect(doc.pages[0].dimensions.height).toBe(842);
  });
});
