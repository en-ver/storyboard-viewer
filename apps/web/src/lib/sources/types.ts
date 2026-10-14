import type { AssetInput, Issue, ReanchorSummary, SbdProject } from '@storyboard-viewer/format';

export type SourceKind = 'server' | 'zip' | 'folder';

/** Turns an asset `src` into a URL the browser can load (null = not available here). */
export interface MediaResolver {
  url(src: string): string | null;
  /** Why a src cannot be resolved (shown in the UI). */
  reason(src: string): string | null;
}

export interface LoadedProject {
  project: SbdProject;
  issues: Issue[];
  reanchor?: ReanchorSummary | null;
  media: MediaResolver;
  /** All package files (used to pick unique media names). */
  files?: string[];
}

export interface SaveRequest {
  /** The state the edits started from (as last loaded or saved). */
  base: SbdProject;
  project: SbdProject;
  /** Embedded media added in the browser and not written yet (package path → bytes). */
  media: ReadonlyMap<string, Blob>;
  /** Client ID (the server tags its change event with it so the app can skip its own echo). */
  client: string;
}

export interface SaveResult {
  /** The project as stored (becomes the new base). */
  project: SbdProject;
  /** Short description of where it went ("Saved to story.sbd"). */
  message?: string;
}

/** The files changed on disk since `base` was loaded: reload, merge, retry. */
export class SaveConflictError extends Error {
  override name = 'SaveConflictError';
  constructor(readonly paths: string[]) {
    super(`Changed elsewhere since you opened it: ${paths.join(', ')}`);
  }
}

/** The save was refused (validation). */
export class SaveRejectedError extends Error {
  override name = 'SaveRejectedError';
  constructor(
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

/**
 * How saving works for a source:
 * - `server`: written by `sbd serve` (validated, atomic), live refresh over SSE
 * - `folder`: written into the folder via the File System Access API
 * - `file`: packed .sbd written through a file handle (asks where the first time)
 * - `download`: packed .sbd downloaded (no file system access)
 * - `none`: read-only (a packed .sbd served by `sbd serve`)
 */
export type SaveMode = 'server' | 'folder' | 'file' | 'download' | 'none';

/**
 * A place a storyboard was opened from. `load()` returns the current state; `watch()` calls back
 * whenever the source changed (SSE for the local server, polling for folders).
 */
export interface ProjectSource {
  kind: SourceKind;
  name: string;
  readOnly: boolean;
  /** Human-readable location (path, file name). */
  location: string;
  /** Server API prefix, without a trailing slash. */
  url?: string;
  /** Server-managed workspace capabilities from the project response. */
  workspace?: { root: 'examples' | 'projects'; label: string };
  /** Folder sources: the directory handle (kept to reopen it from the recent list). */
  handle?: FileSystemDirectoryHandle;
  /** Packed files: the file handle it was opened from (Save writes back into it). */
  fileHandle?: FileSystemFileHandle | null;
  /** Saves go back to where it was opened from without asking (autosave possible). */
  readonly inPlace?: boolean;
  saveMode: SaveMode;
  load(): Promise<LoadedProject>;
  /** `info.origin` is the client that caused the change, when known. */
  watch?(onChange: (info: { origin?: string | null }) => void): () => void;
  /** Persists `project`. Throws SaveConflictError / SaveRejectedError. */
  save?(req: SaveRequest): Promise<SaveResult>;
  /** Server only: copies a file into media/ right away and returns the asset entry to add. */
  uploadMedia?(file: File, client: string): Promise<AssetInput>;
  /** Server only: asset entry for a local file path (linked, `file:` src). */
  linkPath?(path: string, client: string): Promise<AssetInput>;
  /** Packed bytes for saving a working copy / download. */
  packed?(): Promise<Blob>;
  dispose(): void;
}
