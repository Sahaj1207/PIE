import { ViewportTransform } from '../../types/geometry';

export type EditorToolMode = 'select' | 'editText' | 'addText' | 'pan';

export interface EditorSelection {
  readonly pageIndex: number;
  readonly elementId: string;
  readonly elementType: 'textRegion' | 'addedText';
}

export interface EditorSessionState {
  readonly documentId: string;
  readonly activePageIndex: number;
  readonly toolMode: EditorToolMode;
  readonly selection: EditorSelection | null;
  readonly viewportTransform: ViewportTransform;
  readonly hasUnsavedChanges: boolean;
  readonly undoStackDepth: number;
  readonly redoStackDepth: number;
}
