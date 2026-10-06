/**
 * App preferences (appearance, library layout, export defaults, onboarding).
 *
 * A tiny observable store persisted as JSON in the app-private file store
 * (filesDir/pie/settings.json on Android). Without a native file store (Jest) the settings
 * live in memory only. Reading never throws: a missing or corrupt file yields defaults.
 */
import { useSyncExternalStore } from 'react';
import { getNativeFileStore, joinPath } from '../storage/nativeFileStore';
import {
  DEFAULT_ANNOTATION_COLORS,
  PdfAnnotationColors,
  sanitizeAnnotationColors,
} from '../features/pdf/pdfTextSelection';

export type AppearancePreference = 'system' | 'light' | 'dark';
export type LibrarySortMode = 'recent' | 'name' | 'created';
export type LibraryLayout = 'grid' | 'list';
export type ImageExportFormatPref = 'png' | 'jpeg';

export interface AppSettings {
  readonly appearance: AppearancePreference;
  readonly librarySort: LibrarySortMode;
  readonly libraryLayout: LibraryLayout;
  readonly defaultImageExportFormat: ImageExportFormatPref;
  /** JPEG quality 0.5–1.0 */
  readonly defaultImageExportQuality: number;
  readonly haptics: boolean;
  /** Ask before deleting text / pages. */
  readonly confirmDestructive: boolean;
  readonly onboardingComplete: boolean;
  /** Pen colour / width last used for markup (remembered between sessions). */
  readonly markupColor: string;
  readonly markupWidth: number;
  /** Colours for highlighting / underlining / striking through PDF text (independent of text colour). */
  readonly annotationColors: PdfAnnotationColors;
  /** The PDF "long-press to select" tip was seen. */
  readonly pdfSelectionTipSeen: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: 'system',
  librarySort: 'recent',
  libraryLayout: 'grid',
  defaultImageExportFormat: 'png',
  defaultImageExportQuality: 0.92,
  haptics: true,
  confirmDestructive: true,
  onboardingComplete: false,
  markupColor: '#007AFF',
  markupWidth: 4,
  annotationColors: DEFAULT_ANNOTATION_COLORS,
  pdfSelectionTipSeen: false,
};

export const SETTINGS_FILE_NAME = 'settings.json';

const APPEARANCES: readonly AppearancePreference[] = ['system', 'light', 'dark'];
const SORTS: readonly LibrarySortMode[] = ['recent', 'name', 'created'];
const LAYOUTS: readonly LibraryLayout[] = ['grid', 'list'];
const FORMATS: readonly ImageExportFormatPref[] = ['png', 'jpeg'];

/** Validates untrusted JSON into complete settings (unknown/invalid fields -> defaults). */
export function sanitizeSettings(raw: unknown): AppSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const quality =
    typeof src.defaultImageExportQuality === 'number' && Number.isFinite(src.defaultImageExportQuality)
      ? Math.min(1, Math.max(0.5, src.defaultImageExportQuality))
      : DEFAULT_SETTINGS.defaultImageExportQuality;
  const width =
    typeof src.markupWidth === 'number' && Number.isFinite(src.markupWidth)
      ? Math.min(40, Math.max(1, src.markupWidth))
      : DEFAULT_SETTINGS.markupWidth;
  const color =
    typeof src.markupColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(src.markupColor)
      ? src.markupColor
      : DEFAULT_SETTINGS.markupColor;
  return {
    appearance: pick(src.appearance, APPEARANCES, DEFAULT_SETTINGS.appearance),
    librarySort: pick(src.librarySort, SORTS, DEFAULT_SETTINGS.librarySort),
    libraryLayout: pick(src.libraryLayout, LAYOUTS, DEFAULT_SETTINGS.libraryLayout),
    defaultImageExportFormat: pick(src.defaultImageExportFormat, FORMATS, DEFAULT_SETTINGS.defaultImageExportFormat),
    defaultImageExportQuality: quality,
    haptics: bool(src.haptics, DEFAULT_SETTINGS.haptics),
    confirmDestructive: bool(src.confirmDestructive, DEFAULT_SETTINGS.confirmDestructive),
    onboardingComplete: bool(src.onboardingComplete, DEFAULT_SETTINGS.onboardingComplete),
    markupColor: color,
    markupWidth: width,
    annotationColors: sanitizeAnnotationColors(src.annotationColors),
    pdfSelectionTipSeen: bool(src.pdfSelectionTipSeen, DEFAULT_SETTINGS.pdfSelectionTipSeen),
  };
}

type Listener = () => void;

export class SettingsStore {
  private state: AppSettings = DEFAULT_SETTINGS;
  private loaded = false;
  private loadPromise: Promise<AppSettings> | null = null;
  private readonly listeners = new Set<Listener>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly fileStoreFactory = getNativeFileStore) {}

  get(): AppSettings {
    return this.state;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Loads persisted settings once (idempotent). Never rejects. */
  load(): Promise<AppSettings> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const store = this.fileStoreFactory();
        if (store) {
          try {
            const path = joinPath(await store.getRootPath(), SETTINGS_FILE_NAME);
            if (await store.exists(path)) {
              this.state = sanitizeSettings(JSON.parse(await store.readFile(path)));
            }
          } catch {
            this.state = DEFAULT_SETTINGS;
          }
        }
        this.loaded = true;
        this.emit();
        return this.state;
      })();
    }
    return this.loadPromise;
  }

  /** Updates and persists settings (writes are serialized; failures keep the in-memory value). */
  update(patch: Partial<AppSettings>): AppSettings {
    this.state = sanitizeSettings({ ...this.state, ...patch });
    this.emit();
    const snapshot = this.state;
    const store = this.fileStoreFactory();
    if (store) {
      this.writeChain = this.writeChain
        .then(async () => {
          const path = joinPath(await store.getRootPath(), SETTINGS_FILE_NAME);
          await store.writeFileAtomic(path, JSON.stringify(snapshot));
        })
        .catch(() => {});
    }
    return this.state;
  }

  /** Resolves once pending writes have completed (tests, app shutdown). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

export const appSettings = new SettingsStore();

/** React hook: current settings, re-rendering on change. */
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(appSettings.subscribe, () => appSettings.get(), () => appSettings.get());
}
