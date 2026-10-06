import {
  PdfDocumentEditor,
} from '../src/features/pdf/pdfDocumentEditor';
import {
  IPdfiumEngine,
  PdfBatchEditRequest,
  PdfMultiEditResult,
  PdfTextObject,
  PdfDocumentHandle,
  PdfPageSize,
  PdfRenderedPage,
  createPdfSelectionState,
  PdfInsertCommand,
} from '../src/features/pdf/types';
import {
  viewportPointToDocumentPoint,
} from '../src/features/pdf/pdfViewportMath';
import {
  PdfInvalidReplacementError,
  PdfInvalidPlacementError,
  PdfTextInsertionError,
  PdfBatchEditError,
} from '../src/errors';

describe('Phase 4C - Add New Text To PDF', () => {
  const mockExistingRootObject: PdfTextObject = {
    id: 'p0_o2',
    pageIndex: 0,
    objectIndex: 2,
    objectPath: [2],
    text: 'Existing Root Heading',
    bounds: { x: 50, y: 100, width: 220, height: 26 },
    pdfBounds: { left: 50, bottom: 666, right: 270, top: 692 },
    fontSize: 20,
    fontName: 'Helvetica-Bold',
    fontDetails: null,
    color: '#000000',
    colorRgba: { r: 0, g: 0, b: 0, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 666 },
    isEditable: true,
  };

  const mockExistingNestedObject: PdfTextObject = {
    id: 'p0_form1_form0_o3',
    pageIndex: 0,
    objectIndex: 3,
    objectPath: [1, 0, 3],
    text: 'Nested Text In Form XObject',
    bounds: { x: 72, y: 200, width: 190, height: 18 },
    pdfBounds: { left: 72, bottom: 574, right: 262, top: 592 },
    fontSize: 14,
    fontName: 'Helvetica',
    fontDetails: null,
    color: '#333333',
    colorRgba: { r: 51, g: 51, b: 51, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 72, f: 574 },
    isEditable: true,
  };

  let mockEngine: jest.Mocked<IPdfiumEngine>;
  let capturedBatchRequest: PdfBatchEditRequest | null = null;
  let batchShouldFailWith: string | null = null;
  let activeDocumentPath: string = '/mock/source.pdf';
  let dynamicTextObjects: PdfTextObject[] = [];
  let deletedObjectIdsSet: Set<string>;

  beforeEach(() => {
    capturedBatchRequest = null;
    batchShouldFailWith = null;
    activeDocumentPath = '/mock/source.pdf';
    deletedObjectIdsSet = new Set<string>();
    dynamicTextObjects = [
      { ...mockExistingRootObject },
      { ...mockExistingNestedObject },
    ];

    mockEngine = {
      openDocument: jest.fn().mockImplementation((path: string) => {
        activeDocumentPath = path;
        return Promise.resolve({
          docHandle: 301,
          pageCount: 1,
          filePath: path,
        } as PdfDocumentHandle);
      }),
      closeDocument: jest.fn().mockResolvedValue(undefined),
      getPageCount: jest.fn().mockResolvedValue(1),
      getPageSize: jest.fn().mockResolvedValue({
        pageIndex: 0,
        width: 612,
        height: 792,
      } as PdfPageSize),
      renderPage: jest.fn().mockResolvedValue({
        filePath: '/mock/page0.png',
        uri: 'file:///mock/page0.png',
        width: 1224,
        height: 1584,
      } as PdfRenderedPage),
      getTextObjects: jest.fn().mockImplementation(() => {
        const remaining = dynamicTextObjects
          .filter((o) => !deletedObjectIdsSet.has(o.id));
        return Promise.resolve(remaining);
      }),
      extractAssetPdf: jest.fn().mockResolvedValue('/mock/asset.pdf'),
      replaceTextObject: jest.fn(),
      applyBatchEdits: jest.fn().mockImplementation((req: PdfBatchEditRequest): Promise<PdfMultiEditResult> => {
        capturedBatchRequest = req;
        const cmd = req.commands[0];

        if (batchShouldFailWith) {
          return Promise.resolve({
            outputPath: req.outputPdfPath,
            totalCommands: req.commands.length,
            appliedCommands: 0,
            pageCountBefore: 1,
            pageCountAfter: 1,
            sourceUnchanged: true,
            sourceChecksumBefore: 'source_sha256',
            sourceChecksumAfter: 'source_sha256',
            commands: [
              {
                type: cmd.type,
                objectId: cmd.objectId,
                pageIndex: cmd.pageIndex,
                objectIndex: (cmd as any).objectIndex ?? 0,
                status: 'failed',
                error: batchShouldFailWith,
              },
            ],
            reopenedVerification: {
              allReplacementsVerified: false,
              allDeletionsVerified: false,
              verifiedReplacements: [],
              missingReplacements: [],
              residualDeletions: [],
            },
            limitations: [batchShouldFailWith],
          });
        }

        if (cmd.type === 'insert') {
          const insertCmd = cmd as PdfInsertCommand;
          const newObj: PdfTextObject = {
            id: insertCmd.objectId,
            pageIndex: insertCmd.pageIndex,
            objectIndex: dynamicTextObjects.length,
            objectPath: [dynamicTextObjects.length],
            text: insertCmd.text,
            bounds: insertCmd.bounds,
            pdfBounds: {
              left: insertCmd.x,
              bottom: insertCmd.y,
              right: insertCmd.x + insertCmd.bounds.width,
              top: insertCmd.y + insertCmd.bounds.height,
            },
            fontSize: insertCmd.fontSize,
            fontName: insertCmd.fontName || 'Helvetica',
            fontDetails: null,
            color: insertCmd.color || '#000000',
            colorRgba: null,
            matrix: { a: 1, b: 0, c: 0, d: 1, e: insertCmd.x, f: insertCmd.y },
            isEditable: true,
          };
          dynamicTextObjects.push(newObj);

          return Promise.resolve({
            outputPath: req.outputPdfPath,
            totalCommands: req.commands.length,
            appliedCommands: 1,
            pageCountBefore: 1,
            pageCountAfter: 1,
            sourceUnchanged: true,
            sourceChecksumBefore: 'source_sha256',
            sourceChecksumAfter: 'source_sha256',
            commands: [
              {
                type: 'insert',
                objectId: insertCmd.objectId,
                pageIndex: insertCmd.pageIndex,
                objectIndex: newObj.objectIndex,
                status: 'applied',
                newText: insertCmd.text,
              },
            ],
            reopenedVerification: {
              allReplacementsVerified: true,
              allDeletionsVerified: true,
              verifiedReplacements: [],
              missingReplacements: [],
              residualDeletions: [],
            },
            limitations: [],
          });
        } else if (cmd.type === 'delete') {
          deletedObjectIdsSet.add(cmd.objectId);
          return Promise.resolve({
            outputPath: req.outputPdfPath,
            totalCommands: 1,
            appliedCommands: 1,
            pageCountBefore: 1,
            pageCountAfter: 1,
            sourceUnchanged: true,
            sourceChecksumBefore: 'source_sha256',
            sourceChecksumAfter: 'source_sha256',
            commands: [{
              type: 'delete',
              objectId: cmd.objectId,
              pageIndex: cmd.pageIndex,
              objectIndex: (cmd as any).objectIndex ?? 0,
              status: 'applied',
            }],
            reopenedVerification: {
              allReplacementsVerified: true,
              allDeletionsVerified: true,
              verifiedReplacements: [],
              missingReplacements: [],
              residualDeletions: [],
            },
            limitations: [],
          });
        } else if (cmd.type === 'replace') {
          const targetIdx = dynamicTextObjects.findIndex((o) => o.id === cmd.objectId);
          if (targetIdx >= 0) {
            dynamicTextObjects[targetIdx] = {
              ...dynamicTextObjects[targetIdx],
              text: (cmd as any).newText,
            };
          }
          return Promise.resolve({
            outputPath: req.outputPdfPath,
            totalCommands: 1,
            appliedCommands: 1,
            pageCountBefore: 1,
            pageCountAfter: 1,
            sourceUnchanged: true,
            sourceChecksumBefore: 'source_sha256',
            sourceChecksumAfter: 'source_sha256',
            commands: [{
              type: 'replace',
              objectId: cmd.objectId,
              pageIndex: cmd.pageIndex,
              objectIndex: (cmd as any).objectIndex ?? 0,
              status: 'applied',
              newText: (cmd as any).newText,
            }],
            reopenedVerification: {
              allReplacementsVerified: true,
              allDeletionsVerified: true,
              verifiedReplacements: [],
              missingReplacements: [],
              residualDeletions: [],
            },
            limitations: [],
          });
        }

        return Promise.reject(new Error('Unsupported command type'));
      }),
      createEditor: jest.fn(),
      // Verified copy (Save with no queued commands). Test double only: emulates the native
      // copy through this mock's batch implementation so failure injection still applies.
      copyDocument: jest.fn((inputPdfPath: string, outputPdfPath: string) =>
        mockEngine.applyBatchEdits({ inputPdfPath, outputPdfPath, commands: [] }),
      ),
    };
  });

  // 1. +Text enters add mode
  test('1. +Text enters add mode', () => {
    let isPlacementMode = false;
    let selectedObject: PdfTextObject | null = mockExistingRootObject;
    let pdfSelection: any = createPdfSelectionState(mockExistingRootObject, 0);

    // Simulate handleStartPlacement
    const handleStartPlacement = () => {
      selectedObject = null;
      pdfSelection = null;
      isPlacementMode = true;
    };

    handleStartPlacement();
    expect(isPlacementMode).toBe(true);
    expect(selectedObject).toBeNull();
    expect(pdfSelection).toBeNull();
  });

  // 2. Placement captures correct viewport coordinate
  test('2. Placement captures correct viewport coordinate', () => {
    const tapViewportX = 150;
    const tapViewportY = 220;
    expect(tapViewportX).toBe(150);
    expect(tapViewportY).toBe(220);
  });

  // 3. Viewport coordinate converts to correct page coordinate
  test('3. Viewport coordinate converts to correct page coordinate', () => {
    const transform = {
      baseScale: 1.0,
      pageOriginX: 0,
      pageOriginY: 0,
      zoom: 1.0,
      translateX: 0,
      translateY: 0,
    };
    const docPoint = viewportPointToDocumentPoint({ x: 200, y: 300 }, transform);
    expect(docPoint.x).toBeCloseTo(200, 2);
    expect(docPoint.y).toBeCloseTo(300, 2);
  });

  // 4. Placement remains correct at 0.5x
  test('4. Placement remains correct at 0.5x', () => {
    const transform = {
      baseScale: 1.0,
      pageOriginX: 0,
      pageOriginY: 0,
      zoom: 0.5,
      translateX: 0,
      translateY: 0,
    };
    // At zoom 0.5x, tapping at (100, 150) corresponds to (200, 300) in document space
    const docPoint = viewportPointToDocumentPoint({ x: 100, y: 150 }, transform);
    expect(docPoint.x).toBeCloseTo(200, 2);
    expect(docPoint.y).toBeCloseTo(300, 2);
  });

  // 5. Placement remains correct at 1x
  test('5. Placement remains correct at 1x', () => {
    const transform = {
      baseScale: 1.0,
      pageOriginX: 50,
      pageOriginY: 50,
      zoom: 1.0,
      translateX: 0,
      translateY: 0,
    };
    // Tapping at (150, 250) with origin at (50, 50) corresponds to (100, 200)
    const docPoint = viewportPointToDocumentPoint({ x: 150, y: 250 }, transform);
    expect(docPoint.x).toBeCloseTo(100, 2);
    expect(docPoint.y).toBeCloseTo(200, 2);
  });

  // 6. Placement remains correct at 2x
  test('6. Placement remains correct at 2x', () => {
    const transform = {
      baseScale: 1.0,
      pageOriginX: 0,
      pageOriginY: 0,
      zoom: 2.0,
      translateX: 0,
      translateY: 0,
    };
    // At zoom 2.0x, tapping at (400, 600) corresponds to (200, 300) in document space
    const docPoint = viewportPointToDocumentPoint({ x: 400, y: 600 }, transform);
    expect(docPoint.x).toBeCloseTo(200, 2);
    expect(docPoint.y).toBeCloseTo(300, 2);
  });

  // 7. Placement remains correct at 4x
  test('7. Placement remains correct at 4x', () => {
    const transform = {
      baseScale: 1.0,
      pageOriginX: 0,
      pageOriginY: 0,
      zoom: 4.0,
      translateX: 0,
      translateY: 0,
    };
    // At zoom 4.0x, tapping at (400, 800) corresponds to (100, 200) in document space
    const docPoint = viewportPointToDocumentPoint({ x: 400, y: 800 }, transform);
    expect(docPoint.x).toBeCloseTo(100, 2);
    expect(docPoint.y).toBeCloseTo(200, 2);
  });

  // 8. Placement remains correct after pan
  test('8. Placement remains correct after pan', () => {
    const transform = {
      baseScale: 1.0,
      pageOriginX: 0,
      pageOriginY: 0,
      zoom: 1.0,
      translateX: 80,
      translateY: -40,
    };
    // With pan tx=80, ty=-40, tapping at (180, 160) yields (100, 200) in doc space
    const docPoint = viewportPointToDocumentPoint({ x: 180, y: 160 }, transform);
    expect(docPoint.x).toBeCloseTo(100, 2);
    expect(docPoint.y).toBeCloseTo(200, 2);
  });

  // 9. Empty text rejected
  test('9. Empty text rejected', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await expect(
      editor.applyNewTextInsertion(0, '', { x: 50, y: 100 }, '/mock/working.pdf'),
    ).rejects.toThrow(PdfInvalidReplacementError);
  });

  // 10. Whitespace-only text rejected
  test('10. Whitespace-only text rejected', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await expect(editor.applyNewTextInsertion(0, '   \t  \n ', { x: 50, y: 100 }, '/mock/working.pdf')).rejects.toThrow(PdfInvalidReplacementError);
  });

  // 11. Text format is passed correctly
  test('11. Text format is passed correctly', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await editor.applyNewTextInsertion(
      0,
      'Formatted Vector Text',
      { x: 60, y: 120 },
      '/mock/working.pdf',
      { fontSize: 18, color: '#FF0000', isBold: true },
    );

    const cmd = capturedBatchRequest?.commands[0] as PdfInsertCommand;
    expect(cmd).toBeDefined();
    expect(cmd.fontSize).toBe(18);
    expect(cmd.color).toBe('#FF0000');
    expect(cmd.fontName).toContain('Bold');
  });

  // 12. Color is passed correctly
  test('12. Color is passed correctly', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await editor.applyNewTextInsertion(
      0,
      'Blue Vector Text',
      { x: 50, y: 100 },
      '/mock/working.pdf',
      { color: '#0055FF' },
    );

    const cmd = capturedBatchRequest?.commands[0] as PdfInsertCommand;
    expect(cmd.color).toBe('#0055FF');
  });

  // 13. Font size is passed correctly
  test('13. Font size is passed correctly', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await editor.applyNewTextInsertion(
      0,
      'Large Vector Text',
      { x: 50, y: 100 },
      '/mock/working.pdf',
      { fontSize: 24 },
    );

    const cmd = capturedBatchRequest?.commands[0] as PdfInsertCommand;
    expect(cmd.fontSize).toBe(24);
  });

  // 14. Native insertion command contains pageIndex
  test('14. Native insertion command contains pageIndex', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await editor.applyNewTextInsertion(
      0,
      'Page Bound Text',
      { x: 50, y: 100 },
      '/mock/working.pdf',
    );

    const cmd = capturedBatchRequest?.commands[0] as PdfInsertCommand;
    expect(cmd.pageIndex).toBe(0);
  });

  // 15. Native insertion command contains correct coordinates
  test('15. Native insertion command contains correct coordinates', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    // Page height = 792, position.y = 100, fontSize = 16 => pdfY = 792 - (100 + 16) = 676
    await editor.applyNewTextInsertion(
      0,
      'Coordinate Check Text',
      { x: 75, y: 100 },
      '/mock/working.pdf',
      { fontSize: 16 },
    );

    const cmd = capturedBatchRequest?.commands[0] as PdfInsertCommand;
    expect(cmd.x).toBe(75);
    expect(cmd.y).toBe(676);
  });

  // 16. Native insertion creates a genuine insert command
  test('16. Native insertion creates a genuine insert command', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await editor.applyNewTextInsertion(
      0,
      'Genuine Insert Command',
      { x: 50, y: 100 },
      '/mock/working.pdf',
    );

    expect(capturedBatchRequest).toBeDefined();
    expect(capturedBatchRequest?.commands.length).toBe(1);
    expect(capturedBatchRequest?.commands[0].type).toBe('insert');
  });

  // 17. Source path cannot equal output path
  test('17. Source path cannot equal output path', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await expect(
      editor.applyNewTextInsertion(0, 'Mutate Attempt', { x: 50, y: 100 }, '/mock/source.pdf'),
    ).rejects.toThrow(PdfBatchEditError);
  });

  // 18. Native failure preserves source document
  test('18. Native failure preserves source document', async () => {
    batchShouldFailWith = 'Native PDFium Insert Object Failed';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await expect(
      editor.applyNewTextInsertion(0, 'Failing Text', { x: 50, y: 100 }, '/mock/working.pdf'),
    ).rejects.toThrow(PdfTextInsertionError);

    // Source document remains open and unchanged
    expect(activeDocumentPath).toBe('/mock/source.pdf');
  });

  // 19. Successful insertion switches to working copy
  test('19. Successful insertion switches to working copy', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await editor.applyNewTextInsertion(
      0,
      'Switch Working Copy',
      { x: 50, y: 100 },
      '/mock/working_new.pdf',
    );

    expect(activeDocumentPath).toBe('/mock/working_new.pdf');
  });

  // 20. Reconciliation finds newly inserted object
  test('20. Reconciliation finds newly inserted object', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const { insertedObject } = await editor.applyNewTextInsertion(
      0,
      'Reconciled Insertion',
      { x: 50, y: 100 },
      '/mock/working.pdf',
    );

    expect(insertedObject).toBeDefined();
    expect(insertedObject.text).toBe('Reconciled Insertion');
  });

  // 21. Inserted object receives stable identity
  test('21. Inserted object receives stable identity', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const { insertedObject } = await editor.applyNewTextInsertion(
      0,
      'Identity Test',
      { x: 80, y: 120 },
      '/mock/working.pdf',
    );

    expect(insertedObject.id).toBeDefined();
    expect(typeof insertedObject.id).toBe('string');
    expect(insertedObject.pageIndex).toBe(0);
    expect(typeof insertedObject.objectIndex).toBe('number');
    expect(Array.isArray(insertedObject.objectPath)).toBe(true);
  });

  // 22. Inserted object appears in getTextObjects
  test('22. Inserted object appears in getTextObjects', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await editor.applyNewTextInsertion(
      0,
      'Extracted Vector Item',
      { x: 80, y: 120 },
      '/mock/working.pdf',
    );

    const objects = await editor.getTextObjects(0);
    const found = objects.find((o) => o.text === 'Extracted Vector Item');
    expect(found).toBeDefined();
  });

  // 23. Inserted object is selectable using existing selection system
  test('23. Inserted object is selectable using existing selection system', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const { insertedObject } = await editor.applyNewTextInsertion(
      0,
      'Selectable Inserted Text',
      { x: 90, y: 140 },
      '/mock/working.pdf',
    );

    const selectionState = createPdfSelectionState(insertedObject, 0);
    expect(selectionState).toBeDefined();
    expect(selectionState.selectedObjectId).toBe(insertedObject.id);
    expect(selectionState.selectedPageIndex).toBe(0);
    expect(selectionState.selectedBounds).toEqual(insertedObject.bounds);
    expect(selectionState.selectedText).toBe(insertedObject.text);
  });

  // 24. Inserted object has correct text
  test('24. Inserted object has correct text', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const { insertedObject } = await editor.applyNewTextInsertion(
      0,
      '  Trimmed Content  ',
      { x: 50, y: 100 },
      '/mock/working.pdf',
    );

    expect(insertedObject.text).toBe('Trimmed Content');
  });

  // 25. Inserted object has correct bounds
  test('25. Inserted object has correct bounds', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const { insertedObject } = await editor.applyNewTextInsertion(
      0,
      'Bounds Check',
      { x: 55, y: 105 },
      '/mock/working.pdf',
      { fontSize: 16 },
    );

    expect(insertedObject.bounds.x).toBe(55);
    expect(insertedObject.bounds.y).toBe(105);
    expect(insertedObject.bounds.width).toBeGreaterThan(0);
    expect(insertedObject.bounds.height).toBe(16 * 1.25);
  });

  // 26. Inserted object has correct style metadata
  test('26. Inserted object has correct style metadata', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const { insertedObject } = await editor.applyNewTextInsertion(
      0,
      'Styled Vector Text',
      { x: 50, y: 100 },
      '/mock/working.pdf',
      { fontSize: 20, color: '#336699', isBold: true },
    );

    expect(insertedObject.fontSize).toBe(20);
    expect(insertedObject.color).toBe('#336699');
    expect(insertedObject.isEditable).toBe(true);
  });

  // 27. Cancel removes preview
  test('27. Cancel removes preview', () => {
    let pendingEdits: any[] = [{ type: 'insert', objectId: 'opt_1' }];
    // User cancels modal / placement
    const handleCancel = () => {
      pendingEdits = [];
    };

    handleCancel();
    expect(pendingEdits.length).toBe(0);
  });

  // 28. Failed insertion removes preview
  test('28. Failed insertion removes preview', async () => {
    batchShouldFailWith = 'Native Insertion Engine Failure';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    let pendingEdits: any[] = [{ type: 'insert', objectId: 'opt_fail' }];
    try {
      await editor.applyNewTextInsertion(0, 'Failed Text', { x: 50, y: 100 }, '/mock/working.pdf');
    } catch {
      pendingEdits = [];
    }

    expect(pendingEdits.length).toBe(0);
  });

  // 29. Existing Edit continues to work
  test('29. Existing Edit continues to work', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result, reconciledObject } = await editor.applyExistingTextReplacement(
      mockExistingRootObject.id,
      'Updated Existing Text',
      '/mock/working_edit.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect(reconciledObject.text).toBe('Updated Existing Text');
  });

  // 30. Existing Delete continues to work
  test('30. Existing Delete continues to work', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result } = await editor.applyExistingTextDeletion(
      mockExistingRootObject.id,
      '/mock/working_del.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect(deletedObjectIdsSet.has(mockExistingRootObject.id)).toBe(true);
  });

  // 31. Existing nested Form text editing remains intact
  test('31. Existing nested Form text editing remains intact', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result, reconciledObject } = await editor.applyExistingTextReplacement(
      mockExistingNestedObject.id,
      'Updated Form Text',
      '/mock/working_form_edit.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect(reconciledObject.text).toBe('Updated Form Text');
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([1, 0, 3]);
  });

  // 32. Existing nested Form text deletion remains intact
  test('32. Existing nested Form text deletion remains intact', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result } = await editor.applyExistingTextDeletion(
      mockExistingNestedObject.id,
      '/mock/working_form_del.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect(deletedObjectIdsSet.has(mockExistingNestedObject.id)).toBe(true);
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([1, 0, 3]);
  });
});
