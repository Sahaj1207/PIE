import { Document } from '../../types/document';

export interface HistoryState {
  readonly past: Document[];
  readonly present: Document;
  readonly future: Document[];
}

export interface IHistoryManager {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly currentState: Document | null;
  initialize(document: Document): void;
  push(document: Document): void;
  undo(): Document | null;
  redo(): Document | null;
  clear(): void;
}
