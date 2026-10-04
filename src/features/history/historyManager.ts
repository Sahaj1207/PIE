import { Document } from '../../types/document';
import { IHistoryManager } from './types';

const DEFAULT_MAX_HISTORY_DEPTH = 30;

function cloneDocument(doc: Document): Document {
  return JSON.parse(JSON.stringify(doc));
}

export class DocumentHistoryManager implements IHistoryManager {
  private past: Document[] = [];
  private present: Document | null = null;
  private future: Document[] = [];
  private readonly maxDepth: number;

  constructor(maxDepth: number = DEFAULT_MAX_HISTORY_DEPTH) {
    this.maxDepth = Math.max(1, maxDepth);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get currentState(): Document | null {
    return this.present ? cloneDocument(this.present) : null;
  }

  get historyDepth(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  initialize(document: Document): void {
    this.past = [];
    this.present = cloneDocument(document);
    this.future = [];
  }

  push(document: Document): void {
    if (!this.present) {
      this.present = cloneDocument(document);
      return;
    }

    // Push deep-cloned present to past to guarantee snapshot immutability
    this.past.push(cloneDocument(this.present));
    if (this.past.length > this.maxDepth) {
      this.past.shift();
    }

    this.present = cloneDocument(document);
    // Any new action clears redo future
    this.future = [];
  }

  undo(): Document | null {
    if (this.past.length === 0 || !this.present) {
      return null;
    }

    const previous = this.past.pop()!;
    this.future.unshift(cloneDocument(this.present));
    this.present = previous;
    return cloneDocument(this.present);
  }

  redo(): Document | null {
    if (this.future.length === 0 || !this.present) {
      return null;
    }

    const next = this.future.shift()!;
    this.past.push(cloneDocument(this.present));
    this.present = next;
    return cloneDocument(this.present);
  }

  clear(): void {
    this.past = [];
    this.present = null;
    this.future = [];
  }
}
