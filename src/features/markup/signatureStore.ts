/**
 * Saved signatures (vector strokes), stored only on this device in the app-private file
 * store (filesDir/pie/signatures.json). Signatures are normalised into their own bounding
 * box so they can be placed at any size.
 */
import { getNativeFileStore, joinPath } from '../../storage/nativeFileStore';
import { PathCommand, commandsBounds, transformCommands } from './inkPath';

export interface SavedSignature {
  readonly id: string;
  readonly createdAt: number;
  /** Size of the normalised drawing (strokes span 0..width × 0..height). */
  readonly width: number;
  readonly height: number;
  readonly strokes: readonly (readonly PathCommand[])[];
  /** Stroke width relative to the drawing height (keeps proportions when scaled). */
  readonly strokeRatio: number;
}

export const MAX_SAVED_SIGNATURES = 6;
export const SIGNATURES_FILE = 'signatures.json';

const PADDING = 4;

/** Normalises drawn strokes into a signature (null when nothing meaningful was drawn). */
export function createSignature(
  strokes: readonly (readonly PathCommand[])[],
  strokeWidth: number,
  now: number = Date.now(),
): SavedSignature | null {
  const nonEmpty = strokes.filter((s) => s.length > 0);
  const b = commandsBounds(nonEmpty);
  if (!b || (b.width < 8 && b.height < 8)) return null;
  const shifted = nonEmpty.map((s) =>
    transformCommands(s, (p) => ({ x: p.x - b.x + PADDING, y: p.y - b.y + PADDING })),
  );
  const height = b.height + PADDING * 2;
  return {
    id: `sig_${now.toString(36)}`,
    createdAt: now,
    width: b.width + PADDING * 2,
    height,
    strokes: shifted,
    strokeRatio: strokeWidth / height,
  };
}

function isValidSignature(value: any): value is SavedSignature {
  return (
    value &&
    typeof value.id === 'string' &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    Array.isArray(value.strokes) &&
    value.strokes.every((s: unknown) => Array.isArray(s))
  );
}

class SignatureStore {
  private cache: SavedSignature[] | null = null;
  private memoryOnly: SavedSignature[] = [];

  private async path(): Promise<string | null> {
    const store = getNativeFileStore();
    if (!store) return null;
    return joinPath(await store.getRootPath(), SIGNATURES_FILE);
  }

  async list(): Promise<SavedSignature[]> {
    if (this.cache) return this.cache;
    const store = getNativeFileStore();
    const path = await this.path().catch(() => null);
    if (!store || !path) {
      this.cache = this.memoryOnly;
      return this.cache;
    }
    try {
      if (await store.exists(path)) {
        const parsed = JSON.parse(await store.readFile(path));
        this.cache = (Array.isArray(parsed) ? parsed : []).filter(isValidSignature);
      } else {
        this.cache = [];
      }
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async persist(list: SavedSignature[]): Promise<void> {
    this.cache = list;
    const store = getNativeFileStore();
    const path = await this.path().catch(() => null);
    if (!store || !path) {
      this.memoryOnly = list;
      return;
    }
    await store.writeFileAtomic(path, JSON.stringify(list));
  }

  async add(signature: SavedSignature): Promise<SavedSignature[]> {
    const list = [signature, ...(await this.list())].slice(0, MAX_SAVED_SIGNATURES);
    await this.persist(list);
    return list;
  }

  async remove(id: string): Promise<SavedSignature[]> {
    const list = (await this.list()).filter((s) => s.id !== id);
    await this.persist(list);
    return list;
  }
}

export const signatureStore = new SignatureStore();
