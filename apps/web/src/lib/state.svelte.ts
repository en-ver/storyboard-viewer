/**
 * App state (Svelte 5 runes).
 *
 * Editing model: `project` is the working state, `base` the state last loaded from or saved to
 * the source. Every edit applies a pure op from `@storyboard-viewer/format` and pushes the
 * previous project onto the undo history. Saving sends the difference to the source. When the
 * source changes underneath (an agent edit over SSE, a hand edit in the folder) the new state is
 * merged three-way with unsaved local edits (`mergeProjects`), and the history is rebased onto it.
 */
import {
  activeVariant,
  addAsset,
  classifySrc,
  createProject,
  diffProjectFiles,
  exportFountain,
  guessKind,
  mergeProjects,
  mimeForPath,
  orderedShots,
  packSbd,
  probeImageSize,
  projectTree,
  probeWavDuration,
  resolveLines,
  slugify,
  updateManifest,
  validateProject,
  type AssetInput,
  type AssetKind,
  type Issue,
  type PresetId,
  type ReanchorSummary,
  type SbdProject,
  type Shot,
  type Variant,
} from '@storyboard-viewer/format';
import { History } from './history';
import { printParams, readPrintParams, type PrintOptions } from './print';
import {
  clearRecent,
  fetchSharedRecent,
  forgetShared,
  listRecent,
  mergeRecents,
  openShared,
  putSharedThumb,
  putRecent,
  putThumb,
  removeRecent,
  type RecentEntry,
} from './sources/cache';
import {
  CancelledError,
  buildTree,
  canPickFile,
  pickSbdFile,
  downloadBlob,
  folderSource,
  writeTree,
  zipSource,
} from './sources/local';
import { exampleUrl, type BundledExample } from './examples';
import { detectServer, servedBySbd, serverHealth } from './sources/server';
import {
  projectBase,
  workspaceApi,
  type WorkspaceEntry,
  type WorkspaceListing,
  type WorkspaceSelection,
} from './workspace';
import {
  SaveConflictError,
  type MediaResolver,
  type ProjectSource,
  type SaveMode,
} from './sources/types';

export type Tab = 'story' | 'canvas' | 'assets';
/** Story tab layouts: the script editor with shot annotations, or the classic cards. */
export type StoryView = 'script' | 'board';
export const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'story', label: 'Story' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'assets', label: 'Assets' },
];

interface VariantChoice {
  variant: string;
  /** active_variant when the user chose; a different active_variant later wins. */
  base: string | null | undefined;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'agent';
  message: string;
  action?: { label: string; run: () => void };
  /** Stays until dismissed. */
  sticky?: boolean;
}

type EditResult = SbdProject | { project: SbdProject };

const unwrap = (r: EditResult): SbdProject =>
  'manifest' in r && 'ids' in r ? r : (r as { project: SbdProject }).project;

/** ms between the last edit and an automatic save. */
export const AUTOSAVE_DELAY = 350;

const sameContent = (a: SbdProject, b: SbdProject) =>
  Object.keys(diffProjectFiles(a, b)).length === 0;

function pref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`sbd:${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function setPref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`sbd:${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** A directory inside the origin private file system (OPFS), e.g. made by tests. */
async function inPrivateFileSystem(h: FileSystemHandle): Promise<boolean> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    return !!root && (await root.resolve(h)) !== null;
  } catch {
    return false;
  }
}

function narrowScreen(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
}

class AppState {
  source = $state.raw<ProjectSource | null>(null);
  workspace = $state.raw<WorkspaceListing | null>(null);
  workspaceOpen = $state(false);
  workspaceBusy = $state(false);
  workspaceError = $state<string | null>(null);
  private mediaWork = new Set<Promise<unknown>>();
  private switching = false;
  private liveServer = false;
  private switchLocked = $state(false);
  project = $state.raw<SbdProject | null>(null);
  /** State last loaded from / saved to the source. `project !== base` means unsaved changes. */
  base = $state.raw<SbdProject | null>(null);
  issues = $state.raw<Issue[]>([]);
  reanchor = $state.raw<ReanchorSummary | null>(null);
  media = $state.raw<MediaResolver | null>(null);
  status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  error = $state<string | null>(null);
  tab = $state<Tab>('story');
  selectedShot = $state<string | null>(null);
  selectedLine = $state<string | null>(null);
  /** Increments on every (re)load; components can react to live refresh. */
  revision = $state(0);
  lastUpdate = $state<number | null>(null);
  /** Recently opened storyboards (start screen), newest first. */
  recents = $state.raw<RecentEntry[]>([]);
  saving = $state(false);
  saveError = $state<string | null>(null);
  lastSaved = $state<number | null>(null);
  autosave = $state(pref('autosave', true));
  toasts = $state.raw<Toast[]>([]);
  /** Print mode (storyboard sheets / PDF) with its options; null = editor. */
  print = $state.raw<PrintOptions | null>(null);
  /** Print mode opened by a URL with `chrome=0` (headless export): no toolbar. */
  printChrome = $state(true);
  // Phones start on the Board (pictures with their lines); the Script view hides its shot rail there.
  storyView = $state<StoryView>(
    pref<StoryView>('story-view', narrowScreen() ? 'board' : 'script') === 'board'
      ? 'board'
      : 'script',
  );
  /** Asks the script editor to put the cursor on a line (Board → "Edit in script"). */
  revealLine = $state.raw<{ id: string } | null>(null);
  /**
   * An editor holds typed text that is not an edit yet (the script editor between keystrokes and
   * its commit): the save status already says "Unsaved changes".
   */
  buffered = $state(false);
  /** `#tab=timeline` (before 0.3.0): the Soundtrack panel should open. */
  legacyTimeline = $state(false);
  /** Story tab tag filter (shots with any of these tags); empty = all shots. */
  tagFilter = $state.raw<string[]>([]);
  /** Bumps when the undo history changes (History itself is not reactive). */
  private historyVersion = $state(0);
  /** Object URLs for media added in this session (package path → URL). */
  private overrides = $state.raw(new Map<string, string>());
  private choices = $state.raw(new Map<string, VariantChoice>());
  private files = new Set<string>();
  /** Embedded media not yet written to the source (folder / packed file). */
  private pending = new Map<string, Blob>();
  private history = new History<SbdProject>();
  private unwatch: (() => void) | null = null;
  private reloading: Promise<void> | null = null;
  private reloadQueued = false;
  private savePromise: Promise<void> | null = null;
  private saveQueued = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private validateTimer: ReturnType<typeof setTimeout> | undefined;
  private toastId = 0;
  /** Editors with text not yet turned into an edit (the script editor while typing). */
  private flushers = new Set<() => void>();
  private flushing = false;
  readonly client = `web-${Math.random().toString(36).slice(2, 10)}`;

  lines = $derived(this.project ? resolveLines(this.project) : new Map());
  shots = $derived(this.project ? orderedShots(this.project) : []);
  assets = $derived(new Map((this.project?.assets.assets ?? []).map((a) => [a.id, a])));
  /** All shot tags in use, sorted. */
  allTags = $derived(
    [...new Set(Object.values(this.project?.shots ?? {}).flatMap((s) => s.tags ?? []))].toSorted(
      (a, b) => a.localeCompare(b),
    ),
  );
  errorCount = $derived(this.issues.filter((i) => i.severity === 'error').length);
  warningCount = $derived(this.issues.filter((i) => i.severity === 'warning').length);
  dirty = $derived(!!this.project && this.project !== this.base);
  /** Changes not on disk yet, typed text that is not an edit yet included. */
  unsaved = $derived(this.dirty || this.buffered);
  saveMode = $derived<SaveMode>(this.source?.saveMode ?? 'none');
  canEdit = $derived(
    !!this.project &&
      !!this.source?.save &&
      !this.source.readOnly &&
      this.saveMode !== 'none' &&
      !this.switchLocked,
  );
  /**
   * Saving by itself: sbd serve, folders, and packed files opened through a file handle
   * (Chromium), which are written back in place. (`lastSaved`: the handle may arrive with the
   * first save.)
   */
  canAutosave = $derived.by(() => {
    void this.lastSaved;
    return (
      this.saveMode === 'server' ||
      this.saveMode === 'folder' ||
      (this.source?.kind === 'zip' && !!this.source.inPlace)
    );
  });
  undoLabel = $derived.by(() => {
    void this.historyVersion;
    return this.history.undoLabel;
  });
  redoLabel = $derived.by(() => {
    void this.historyVersion;
    return this.history.redoLabel;
  });

  /** Startup: connect to `sbd serve` when served by it, else offer to reopen the last file. */
  async init(): Promise<void> {
    this.print = readPrintParams(location.search);
    this.printChrome = new URLSearchParams(location.search).get('chrome') !== '0';
    this.readHash();
    window.addEventListener('hashchange', () => this.readHash());
    window.addEventListener('beforeunload', (e) => {
      if (this.unsaved || this.saving || this.pending.size || this.mediaWork.size)
        e.preventDefault();
    });
    // `?source=local` skips auto-connecting to `sbd serve` (open another file instead).
    const local = new URLSearchParams(location.search).get('source') === 'local';
    // The generic shell marker permits probing; only live root health determines mode.
    // Both legacy and workspace shells can be cached across listener restarts.
    const health = servedBySbd() ? await serverHealth() : null;
    this.liveServer = !!health;
    if (health?.mode === 'workspace') {
      try {
        await this.refreshWorkspace();
        if (!local) {
          // The service worker can reuse a shell with another project's metadata.
          // The scoped address, not the cached shell, identifies this tab's project.
          const base = projectBase(
            /^\/p\/[a-f0-9]{48}\/$/.test(location.pathname)
              ? location.pathname
              : this.workspace!.initial.url,
          );
          const server = await detectServer(base);
          if (!server) throw new Error('Could not load the selected workspace storyboard.');
          await this.open(server);
          return;
        }
      } catch (e) {
        this.error = (e as Error).message;
        this.status = 'error';
        return;
      }
    }
    const server = local || !this.liveServer ? null : await detectServer('');
    if (server) {
      await this.open(server);
      return;
    }
    await this.loadRecents();
  }

  reportWarnings = (warnings: string[]): void => {
    for (const message of new Set(warnings)) this.toast(message, { kind: 'error', sticky: true });
  };

  async refreshWorkspace(): Promise<void> {
    this.workspace = await workspaceApi.list();
    this.reportWarnings([...this.workspace.warnings, ...this.workspace.diagnostics]);
    await this.loadRecents();
  }

  /** Drain editors and media before any operation that can retire or replace this tab's source. */
  async finishBeforeSwitch(hold = false): Promise<boolean> {
    if (this.switching) return false;
    this.switching = true;
    let finished = false;
    try {
      // Already admitted media edits finish before editors are frozen.
      while (this.mediaWork.size) await Promise.allSettled(this.mediaWork);
      this.flushEdits();
      this.switchLocked = true;
      clearTimeout(this.autosaveTimer);
      // A queued save can outlive the first save promise. Drain the entire queue.
      while (this.savePromise) await this.savePromise;
      await this.save({ auto: true });
      while (this.savePromise) await this.savePromise;
      if (this.saveError || this.unsaved || this.pending.size || this.saving) {
        if (!confirm('Changes were not saved. Discard them and switch storyboards?')) return false;
        this.discardLocal();
        this.pending.clear();
        this.buffered = false;
        this.saveError = null;
      }
      finished = true;
      return true;
    } finally {
      if (!hold || !finished) {
        this.switching = false;
        this.switchLocked = false;
      }
    }
  }

  async workspaceAction(
    action: () => Promise<WorkspaceSelection>,
    message?: string,
  ): Promise<boolean> {
    if (this.workspaceBusy) return false;
    this.workspaceBusy = true;
    this.workspaceError = null;
    try {
      if (!(await this.finishBeforeSwitch(true))) return false;
      const selected = await action();
      this.reportWarnings(selected.warnings);
      const base = projectBase(selected.url);
      const source = await detectServer(base);
      if (!source)
        throw new Error(
          'The project operation succeeded, but loading failed. Reopen it from Projects.',
        );
      await this.open(source, { prepared: true });
      if (this.source !== source || this.status !== 'ready')
        throw new Error(this.error ?? 'Could not load storyboard.');
      await this.refreshWorkspace();
      this.workspaceOpen = false;
      if (message) this.toast(message, { kind: 'info' });
      return true;
    } catch (e) {
      this.workspaceError = (e as Error).message;
      this.toast(this.workspaceError, { kind: 'error', sticky: true });
      return false;
    } finally {
      this.switching = false;
      this.switchLocked = false;
      this.workspaceBusy = false;
    }
  }

  openWorkspace(entry: WorkspaceEntry): Promise<boolean> {
    return this.workspaceAction(() => workspaceApi.open(this.client, entry.root, entry.name));
  }

  /** This browser's recent list merged with the shared one of `sbd serve` (when served). */
  async loadRecents(): Promise<void> {
    const [local, shared] = await Promise.all([
      listRecent(),
      this.liveServer
        ? fetchSharedRecent('', this.workspace ? this.reportWarnings : undefined)
        : [],
    ]);
    const browser = this.workspace ? local.filter((entry) => entry.kind !== 'server') : local;
    this.recents = mergeRecents(browser, shared);
  }

  async open(
    source: ProjectSource,
    opts: { remember?: boolean; prepared?: boolean } = {},
  ): Promise<void> {
    if (!opts.prepared && !(await this.finishBeforeSwitch(true))) {
      source.dispose();
      return;
    }
    try {
      if (!this.project) this.status = 'loading';
      // Finish an old-source refresh before validating the replacement. A failed load must
      // leave the previous model, source and address intact.
      while (this.reloading) await this.reloading;
      const loaded = await source.load();
      if (source.workspace) {
        const base = projectBase(`${source.url ?? ''}/`);
        // Commit the validated route before any new source/selection/ready state is visible.
        // IndexedDB history and thumbnail work are not part of this transition.
        history.replaceState(null, '', `${base}/${location.hash}`);
      }
      this.close();
      this.source = source;
      this.project = loaded.project;
      this.base = loaded.project;
      this.media = loaded.media;
      this.files = new Set(loaded.files ?? []);
      this.reanchor = loaded.reanchor ?? null;
      this.issues = loaded.issues;
      if (this.selectedShot && !loaded.project.shots[this.selectedShot]) this.selectedShot = null;
      this.error = null;
      this.revision++;
      document.title = `${loaded.project.manifest.title} — Storyboard Viewer`;
      this.unwatch =
        source.watch?.((info) => {
          if (info.origin && info.origin === this.client) return; // our own save
          void this.reload();
        }) ?? null;
      this.status = 'ready';
      if (opts.remember !== false) void this.remember();
    } catch (e) {
      if (this.source !== source) source.dispose();
      if (!this.project) this.status = 'error';
      this.error = (e as Error).message;
    } finally {
      if (!opts.prepared) {
        this.switching = false;
        this.switchLocked = false;
      }
    }
  }

  /**
   * Puts the open storyboard at the top of the recent list (packed files with a copy of their
   * bytes, folders with their handle, `sbd serve` with its URL) and makes a small thumbnail.
   */
  private async remember(): Promise<void> {
    const src = this.source;
    const p = this.project;
    const media = this.media;
    if (!src || !p) return;
    try {
      const entry: RecentEntry = {
        id: '',
        kind: src.kind,
        title: p.manifest.title,
        name: src.name,
        location: '',
        openedAt: Date.now(),
      };
      if (src.kind === 'server') {
        const url = new URL(`${src.url ?? ''}/`, location.origin).href;
        entry.id = `server:${url}`;
        entry.url = url;
        const file = src.location.split(/[\\/]/).filter(Boolean).at(-1) ?? src.name;
        entry.location = `${location.host} · ${file}`;
        entry.path = src.location;
      } else if (src.kind === 'folder') {
        // only folders the user picked can be reopened (not the browser's private file system)
        if (!src.handle || (await inPrivateFileSystem(src.handle))) return;
        entry.id = `folder:${src.name}`;
        entry.location = 'Folder';
        entry.handle = src.handle;
      } else if (src.fileHandle && !(await inPrivateFileSystem(src.fileHandle))) {
        // reopened through its handle (saves keep going into the same file)
        entry.id = `zip:${src.name}`;
        entry.location = '.sbd file';
        entry.fileHandle = src.fileHandle;
      } else {
        if (!src.packed) return;
        entry.id = `zip:${src.name}`;
        entry.location = '.sbd file';
        entry.blob = await src.packed();
      }
      await putRecent(entry);
      void this.makeThumb(entry.id, p, src, media);
    } catch {
      /* the recent list is a convenience */
    }
  }

  /** A small picture of the first shot that has one (for the recent list). */
  private async makeThumb(
    id: string,
    p: SbdProject,
    source: ProjectSource,
    media: MediaResolver | null,
  ): Promise<void> {
    if (!p || typeof document === 'undefined') return;
    for (const { shot } of orderedShots(p)) {
      const v = activeVariant(shot);
      const assetId = v?.type === 'image' ? v.asset : v?.preview;
      const asset = assetId ? p.assets.assets.find((a) => a.id === assetId) : undefined;
      if (!asset || asset.kind !== 'image') continue;
      const url = media?.url(asset.src);
      if (!url) continue;
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = url;
        await img.decode();
        const h = 72;
        const w = Math.max(1, Math.round((img.naturalWidth / img.naturalHeight) * h));
        const c = document.createElement('canvas');
        c.width = Math.min(w, 160);
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.7));
        if (blob) {
          await putThumb(id, blob);
          if (source.kind === 'server' && this.source === source)
            await putSharedThumb(
              this.client,
              blob,
              source.url ?? '',
              source.workspace ? this.reportWarnings : undefined,
            );
        }
      } catch {
        /* no thumbnail */
      }
      return;
    }
  }

  /** Opens a storyboard from the recent list. */
  async reopenRecent(entry: RecentEntry): Promise<void> {
    if (this.workspace && entry.path) {
      const known = [...this.workspace.examples, ...this.workspace.projects].find(
        (e) => e.path === entry.path,
      );
      if (known) {
        await this.openWorkspace(known);
        return;
      }
      if (entry.kind === 'served' || entry.kind === 'server') {
        this.toast(
          'This storyboard is no longer in the workspace. Refresh Projects and choose it again.',
          { kind: 'error' },
        );
        return;
      }
    }
    if (!(await this.finishBeforeSwitch())) return;
    if (entry.kind === 'served' && entry.path) {
      // a viewer for it: already running, or started by this server on the next free port
      try {
        location.href = await openShared(this.client, entry.path);
      } catch (e) {
        this.toast(`Could not open “${entry.title}”: ${(e as Error).message}`, { kind: 'error' });
      }
      return;
    }
    if (entry.kind === 'server' && entry.url) {
      location.href = entry.url;
      return;
    }
    if (entry.kind === 'folder' && entry.handle) {
      const h = entry.handle as FileSystemDirectoryHandle & {
        queryPermission?: (o: object) => Promise<PermissionState>;
        requestPermission?: (o: object) => Promise<PermissionState>;
      };
      try {
        let state = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
        if (state !== 'granted')
          state = (await h.requestPermission?.({ mode: 'readwrite' })) ?? state;
        if (state !== 'granted') {
          this.toast(`No access to the folder “${entry.name}”.`, { kind: 'error' });
          return;
        }
      } catch (e) {
        this.toast((e as Error).message, { kind: 'error' });
        return;
      }
      await this.open(folderSource(entry.handle));
      return;
    }
    if (entry.fileHandle) {
      const h = entry.fileHandle as FileSystemFileHandle & {
        queryPermission?: (o: object) => Promise<PermissionState>;
        requestPermission?: (o: object) => Promise<PermissionState>;
      };
      try {
        let state = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
        if (state !== 'granted')
          state = (await h.requestPermission?.({ mode: 'readwrite' })) ?? state;
        if (state === 'granted') {
          await this.openFile(await h.getFile(), h);
          return;
        }
      } catch {
        /* moved or deleted: fall back to the stored copy below, if any */
      }
      if (!entry.blob) {
        this.toast(`No access to “${entry.name}”. Open it again with Open .sbd file.`, {
          kind: 'error',
        });
        return;
      }
    }
    if (entry.blob) {
      await this.open(zipSource(entry.blob, entry.name));
      return;
    }
    this.toast(`“${entry.title}” can no longer be opened from here.`, { kind: 'error' });
  }

  async forgetRecent(id: string): Promise<void> {
    const entry = this.recents.find((r) => r.id === id);
    if (entry?.kind === 'served' && entry.path) {
      await forgetShared(
        this.client,
        entry.path,
        '',
        this.workspace ? this.reportWarnings : undefined,
      );
      // this browser's entries for the same storyboard (other ports) go too
      for (const r of await listRecent()) if (r.path === entry.path) await removeRecent(r.id);
    } else await removeRecent(id);
    await this.loadRecents();
  }

  async clearRecents(): Promise<void> {
    await clearRecent();
    if (this.liveServer)
      await forgetShared(
        this.client,
        undefined,
        '',
        this.workspace ? this.reportWarnings : undefined,
      ); // shared history
    this.recents = [];
  }

  /**
   * Loads the source's current state. Without local edits it replaces the project; with unsaved
   * edits it merges (agent changes + yours), keeping tab, selection and scroll either way.
   */
  async reload(): Promise<void> {
    if (this.reloading) {
      this.reloadQueued = true;
      return this.reloading;
    }
    const src = this.source;
    if (!src) return;
    this.reloading = (async () => {
      // Never merge against a half-finished save.
      while (this.savePromise) await this.savePromise;
      await this.pull(src);
    })();
    try {
      await this.reloading;
    } finally {
      this.reloading = null;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        await this.reload();
      }
    }
  }

  /** Loads the source and merges it into the working state (see `reload`). */
  private async pull(src: ProjectSource): Promise<void> {
    // Typed text that is not an edit yet must be part of "ours" before merging.
    this.flushEdits();
    try {
      const loaded = await src.load();
      if (this.source !== src) return;
      this.media = loaded.media;
      this.files = new Set(loaded.files ?? []);
      this.reanchor = loaded.reanchor ?? null;
      const remote = loaded.project;
      const first = !this.project || !this.base;
      if (!first && sameContent(remote, this.base!)) {
        // Echo of our own save, or a touch without content changes.
        this.revision++;
        return;
      }
      if (first) {
        this.project = remote;
        this.base = remote;
        this.issues = loaded.issues;
      } else {
        const oldBase = this.base!;
        const wasDirty = this.dirty;
        this.history.map((s) => mergeProjects(oldBase, s, remote).project);
        this.historyVersion++;
        if (!wasDirty) {
          this.project = remote;
          this.base = remote;
          this.issues = loaded.issues;
        } else {
          const merged = mergeProjects(oldBase, this.project!, remote);
          this.base = remote;
          this.project = sameContent(merged.project, remote) ? remote : merged.project;
          this.revalidate();
          this.toast(
            merged.conflicts.length
              ? `Updated by agent. ${merged.conflicts.length} change${merged.conflicts.length > 1 ? 's' : ''} conflicted; your version was kept.`
              : 'Updated by agent. Your unsaved changes were kept.',
            {
              kind: 'agent',
              sticky: merged.conflicts.length > 0,
              action: {
                label: 'Use agent’s version',
                run: () => this.discardLocal(),
              },
            },
          );
        }
        this.lastUpdate = Date.now();
      }
      this.status = 'ready';
      this.error = null;
      this.revision++;
      const p = this.project!;
      if (this.selectedShot && !p.shots[this.selectedShot]) this.selectedShot = null;
      if (this.selectedLine && !p.ids.lines.some((l) => l.id === this.selectedLine))
        this.selectedLine = null;
      // Drop variant choices once the active variant changed underneath them (agent edits win).
      const kept = new Map(
        [...this.choices].filter(([id, c]) => p.shots[id]?.active_variant === c.base),
      );
      if (kept.size !== this.choices.size) this.choices = kept;
      document.title = `${p.manifest.title} — Storyboard Viewer`;
    } catch (e) {
      if (this.status !== 'ready') this.status = 'error';
      this.error = (e as Error).message;
    }
  }

  /** Throws away unsaved edits and shows the source's state. */
  discardLocal(): void {
    this.flushEdits();
    if (!this.base) return;
    if (this.project !== this.base) this.history.push(this.project!, 'Discard my changes');
    this.historyVersion++;
    this.project = this.base;
    this.revalidate();
  }

  close(): void {
    clearTimeout(this.autosaveTimer);
    clearTimeout(this.validateTimer);
    this.buffered = false;
    this.unwatch?.();
    this.unwatch = null;
    this.source?.dispose();
    this.source = null;
    this.project = null;
    this.base = null;
    this.issues = [];
    this.media = null;
    this.status = 'idle';
    this.revision = 0;
    this.lastUpdate = null;
    this.choices = new Map();
    this.history.clear();
    this.historyVersion++;
    this.pending.clear();
    for (const u of this.overrides.values()) URL.revokeObjectURL(u);
    this.overrides = new Map();
    this.selectedLine = null;
    this.saveError = null;
    document.title = 'Storyboard Viewer';
    void this.loadRecents();
  }

  /**
   * Opens a packed .sbd. With a file handle (File System Access API) Save and autosave write
   * back into that file; the bytes are copied into memory first, because a File read from a
   * handle becomes unreadable once the file is written.
   */
  async openFile(file: File, handle?: FileSystemFileHandle | null): Promise<void> {
    const blob = handle
      ? new Blob([await file.arrayBuffer()], { type: 'application/vnd.sbd+zip' })
      : file;
    return this.open(zipSource(blob, file.name, handle));
  }

  /** File → Open: the system file picker (Chromium: saves in place), else `fallback()`. */
  async pickFile(fallback: () => void): Promise<void> {
    if (!canPickFile) {
      fallback();
      return;
    }
    const handle = await pickSbdFile();
    if (!handle) return;
    try {
      await this.openFile(await handle.getFile(), handle);
    } catch (e) {
      this.error = `Could not open ${handle.name}: ${(e as Error).message}`;
    }
  }

  /** Opens a bundled example like a dropped .sbd file (edits stay in the browser until saved). */
  async openExample(example: BundledExample): Promise<void> {
    this.error = null;
    let blob: Blob;
    try {
      const res = await fetch(exampleUrl(example));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      blob = await res.blob();
    } catch (e) {
      this.error = `Could not load the example “${example.title}” (${(e as Error).message}).`;
      return;
    }
    await this.open(zipSource(blob, example.file));
  }

  async openFolder(): Promise<void> {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (!picker) return;
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker({ mode: 'readwrite' });
    } catch {
      return; // cancelled
    }
    await this.open(folderSource(handle));
  }

  /**
   * Creates a new storyboard from a preset and opens it: in the browser (a new .sbd file that is
   * saved with Save) or as a `<title>.sbd/` folder inside a folder the user picks (autosaves).
   */
  async createNew(
    opts: { title: string; preset: PresetId },
    where: 'browser' | 'folder',
  ): Promise<boolean> {
    const project = createProject({ title: opts.title, preset: opts.preset });
    const tree = projectTree(project);
    const stem = slugify(opts.title, 'storyboard');
    if (where === 'folder') {
      const picker = (
        window as unknown as {
          showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker;
      if (!picker) return false;
      let parent: FileSystemDirectoryHandle;
      try {
        parent = await picker({ mode: 'readwrite' });
      } catch {
        return false; // cancelled
      }
      let name = `${stem}.sbd`;
      for (let n = 2; await hasEntry(parent, name); n++) name = `${stem}-${n}.sbd`;
      const dir = await parent.getDirectoryHandle(name, { create: true });
      await dir.getDirectoryHandle('media', { create: true });
      await writeTree(dir, tree);
      await this.open(folderSource(dir));
      this.toast(`Created ${parent.name}/${name}. Changes save automatically.`, { kind: 'info' });
      return true;
    }
    const blob = new Blob([packSbd(tree) as BlobPart], { type: 'application/vnd.sbd+zip' });
    await this.open(zipSource(blob, `${stem}.sbd`));
    this.toast('New storyboard created. Use Save to keep it as a .sbd file.', { kind: 'info' });
    return true;
  }

  // --- editing

  /**
   * Applies an edit op to the project. `label` names the action for undo ("Move shot"). Ops
   * that throw (invalid input) show the message and change nothing. Returns false on failure.
   */
  edit(
    label: string,
    fn: (p: SbdProject) => EditResult,
    opts: { coalesce?: string } = {},
  ): boolean {
    this.flushEdits();
    const cur = this.project;
    if (!cur || !this.canEdit) return false;
    let next: SbdProject;
    try {
      next = unwrap(fn(cur));
    } catch (e) {
      this.toast((e as Error).message, { kind: 'error' });
      return false;
    }
    if (next === cur) return true;
    this.history.push(cur, label, opts.coalesce);
    this.historyVersion++;
    this.project = next;
    this.afterChange();
    return true;
  }

  /**
   * Registers an editor that buffers input (e.g. typing in the script editor). Its flush turns
   * the buffer into an edit; it runs before any other edit, undo/redo, save and merge.
   */
  registerFlush(fn: () => void): () => void {
    this.flushers.add(fn);
    return () => this.flushers.delete(fn);
  }

  flushEdits(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const f of this.flushers) f();
    } finally {
      this.flushing = false;
    }
  }

  undo(): void {
    if (!this.canEdit) return;
    this.flushEdits();
    if (!this.project) return;
    const e = this.history.undo(this.project);
    if (!e) return;
    this.historyVersion++;
    this.project = e.state;
    this.afterChange();
    this.toast(`Undid: ${e.label}`, { kind: 'info' });
  }

  redo(): void {
    if (!this.canEdit) return;
    this.flushEdits();
    if (!this.project) return;
    const e = this.history.redo(this.project);
    if (!e) return;
    this.historyVersion++;
    this.project = e.state;
    this.afterChange();
    this.toast(`Redid: ${e.label}`, { kind: 'info' });
  }

  private afterChange(): void {
    const p = this.project!;
    if (this.selectedShot && !p.shots[this.selectedShot]) this.selectedShot = null;
    this.revalidate();
    this.scheduleAutosave();
  }

  private revalidate(): void {
    clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => {
      const p = this.project;
      if (!p) return;
      const files = this.files;
      this.issues = validateProject(p, {
        hasFile: (path) => files.has(path) || this.pending.has(path) || this.overrides.has(path),
      });
    }, 250);
  }

  setAutosave(on: boolean): void {
    this.autosave = on;
    setPref('autosave', on);
    if (on) this.scheduleAutosave();
  }

  private scheduleAutosave(): void {
    clearTimeout(this.autosaveTimer);
    if (!this.autosave || !this.canAutosave) return;
    // Short: with the script editor's commit delay, typed text reaches the disk within ~1 s of
    // the last keystroke.
    this.autosaveTimer = setTimeout(() => void this.save({ auto: true }), AUTOSAVE_DELAY);
  }

  /** Saves through the source (merging and retrying once when the source changed meanwhile). */
  async save(opts: { auto?: boolean } = {}): Promise<void> {
    this.flushEdits();
    if (this.savePromise) {
      this.saveQueued = true;
      return this.savePromise;
    }
    const src = this.source;
    if (!src?.save || !this.project || !this.base) return;
    if (!this.dirty && !this.pending.size) {
      if (!opts.auto && src.saveMode === 'download') await this.saveNow(src, opts);
      return;
    }
    this.savePromise = this.saveNow(src, opts);
    try {
      await this.savePromise;
    } finally {
      this.savePromise = null;
      if (this.saveQueued) {
        this.saveQueued = false;
        if (this.dirty) await this.save({ auto: true });
      }
    }
  }

  private async saveNow(src: ProjectSource, opts: { auto?: boolean }): Promise<void> {
    this.saving = true;
    try {
      for (let attempt = 0; ; attempt++) {
        const snapshot = this.project!;
        let target = snapshot;
        if (src.kind !== 'server' && this.dirty)
          target = updateManifest(snapshot, { modified: new Date().toISOString() });
        try {
          const media = new Map(this.pending);
          const res = await src.save!({
            base: this.base!,
            project: target,
            media,
            client: this.client,
          });
          if (this.source !== src) return;
          for (const k of media.keys()) this.pending.delete(k);
          for (const k of media.keys()) this.files.add(k);
          this.base = res.project;
          if (this.project === snapshot) this.project = res.project;
          this.lastSaved = Date.now();
          this.saveError = null;
          if (!opts.auto && res.message) this.toast(res.message, { kind: 'info' });
          if (src.kind === 'zip') void this.remember();
          return;
        } catch (e) {
          if (e instanceof SaveConflictError && attempt === 0) {
            // Someone else changed those files: pull their version, merge, try again.
            await this.pull(src);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) return;
      this.saveError = (e as Error).message;
      this.toast(`Not saved: ${(e as Error).message}`, { kind: 'error', sticky: true });
    } finally {
      this.saving = false;
    }
  }

  // --- export

  /** The current state (including unsaved edits and new media) as a package tree. */
  private async currentTree(): Promise<Record<string, Uint8Array>> {
    const src = this.source!;
    const packed = src.packed ? await src.packed() : null;
    return buildTree(this.project!, packed, this.pending);
  }

  private fileStem(): string {
    return (this.source?.name ?? 'storyboard').replace(/\.sbd$/i, '').replace(/\/+$/, '');
  }

  /** Downloads the current state as a packed .sbd. */
  async exportPacked(): Promise<void> {
    if (!this.project || !this.source) return;
    try {
      const bytes = packSbd(await this.currentTree());
      downloadBlob(
        new Blob([bytes as BlobPart], { type: 'application/vnd.sbd+zip' }),
        `${this.fileStem()}.sbd`,
      );
    } catch (e) {
      this.toast(`Export failed: ${(e as Error).message}`, { kind: 'error' });
    }
  }

  /** Downloads the script as a plain Fountain file (opens in any screenwriting app). */
  exportFountainFile(): void {
    if (!this.project) return;
    const text = exportFountain(this.project);
    downloadBlob(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
      `${this.fileStem()}.fountain`,
    );
  }

  /** File name stem for exports (`my-film`). */
  get exportStem(): string {
    return this.fileStem();
  }

  /**
   * Reads one package file of the current state (unsaved media included): used by exporters that
   * need bytes rather than URLs.
   */
  async mediaBlob(src: string): Promise<Blob | null> {
    const url = this.mediaUrl(src);
    if (!url) return null;
    try {
      const res = await fetch(url);
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  }

  /** Writes the current state as an unpacked `<name>.sbd/` folder into a folder the user picks. */
  async exportFolder(): Promise<void> {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (!picker || !this.project) return;
    let parent: FileSystemDirectoryHandle;
    try {
      parent = await picker({ mode: 'readwrite' });
    } catch {
      return;
    }
    try {
      const dir = await parent.getDirectoryHandle(`${this.fileStem()}.sbd`, { create: true });
      await writeTree(dir, await this.currentTree());
      this.toast(`Exported to ${parent.name}/${dir.name}`, {
        kind: 'info',
        action: { label: 'Edit that folder', run: () => void this.open(folderSource(dir)) },
      });
    } catch (e) {
      this.toast(`Export failed: ${(e as Error).message}`, { kind: 'error' });
    }
  }

  /** Read-only source (packed .sbd served by `sbd serve`): continue on an in-browser copy. */
  async editCopy(): Promise<void> {
    const src = this.source;
    if (src?.workspace) {
      this.workspaceOpen = true;
      return;
    }
    if (!src?.packed) return;
    const blob = await src.packed();
    await this.open(zipSource(blob, src.name));
    this.toast('Editing a copy in the browser. Save writes a new .sbd file.', { kind: 'info' });
  }

  /** Shows the print view (storyboard sheets) with these options; the URL keeps them. */
  openPrint(opts: PrintOptions): void {
    this.print = opts;
    this.setPrintUrl(opts);
  }

  closePrint(): void {
    this.print = null;
    this.setPrintUrl(null);
  }

  private setPrintUrl(opts: PrintOptions | null): void {
    const q = new URLSearchParams(location.search);
    for (const k of [
      'print',
      'layout',
      'per',
      'paper',
      'lines',
      'fields',
      'notes',
      'title',
      'chrome',
    ])
      q.delete(k);
    if (opts) for (const [k, v] of printParams(opts)) q.set(k, v);
    const search = q.toString();
    history.replaceState(
      null,
      '',
      `${location.pathname}${search ? `?${search}` : ''}${location.hash}`,
    );
  }

  // --- media import

  /** Unique `media/<slug>.<ext>` path among package files and pending media. */
  private mediaPath(name: string): string {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
    const stem = slugify(dot > 0 ? name.slice(0, dot) : name, 'asset');
    let path = `media/${stem}${ext}`;
    for (let n = 2; this.files.has(path) || this.pending.has(path); n++)
      path = `media/${stem}-${n}${ext}`;
    return path;
  }

  private setOverride(path: string, blob: Blob): void {
    this.overrides = new Map(this.overrides).set(path, URL.createObjectURL(blob));
  }

  /**
   * Builds an asset entry for a dropped/picked file: uploaded into media/ by `sbd serve`, or kept
   * in memory and written on save (folder, packed file). Does not add it to the project.
   */
  async prepareFile(file: File): Promise<AssetInput> {
    if (this.switching || !this.canEdit)
      throw new Error('This storyboard is read-only or switching.');
    const work = this.prepareFileNow(file);
    this.mediaWork.add(work);
    try {
      return await work;
    } finally {
      this.mediaWork.delete(work);
    }
  }

  private async prepareFileNow(file: File): Promise<AssetInput> {
    const src = this.source;
    if (!src) throw new Error('No storyboard open');
    const kind = guessKind(file.name) ?? (file.type ? guessKind(file.type) : undefined);
    if (!kind) throw new Error(`${file.name}: unsupported file type`);
    if (src.uploadMedia) {
      const asset = await src.uploadMedia(file, this.client);
      if (this.source !== src)
        throw new Error('The storyboard changed during upload. Reopen the original project.');
      const info = classifySrc(asset.src);
      if (info?.kind === 'embedded') {
        this.files.add(info.path);
        this.setOverride(info.path, file);
      }
      return asset;
    }
    const path = this.mediaPath(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dot = file.name.lastIndexOf('.');
    const asset: AssetInput = {
      name: dot > 0 ? file.name.slice(0, dot) : file.name,
      kind,
      src: path,
      mime: file.type || mimeForPath(file.name),
      size: file.size,
    };
    Object.assign(asset, await probeMedia(file, bytes, kind));
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      asset.sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      /* no WebCrypto (insecure context) */
    }
    if (this.source !== src) throw new Error('The storyboard changed during import.');
    this.pending.set(path, file);
    this.setOverride(path, file);
    return asset;
  }

  /** Imports files as embedded assets (one undo step). Returns the new asset IDs. */
  async importFiles(files: File[], extra: Partial<AssetInput> = {}): Promise<string[]> {
    if (this.switching || !this.canEdit) return [];
    const work = this.importFilesNow(files, extra);
    this.mediaWork.add(work);
    try {
      return await work;
    } finally {
      this.mediaWork.delete(work);
    }
  }

  private async importFilesNow(files: File[], extra: Partial<AssetInput>): Promise<string[]> {
    const inputs: AssetInput[] = [];
    for (const f of files) {
      try {
        inputs.push({ ...(await this.prepareFileNow(f)), ...extra });
      } catch (e) {
        this.toast((e as Error).message, { kind: 'error' });
      }
    }
    const ids: string[] = [];
    if (!inputs.length) return ids;
    this.edit(inputs.length === 1 ? 'Import asset' : `Import ${inputs.length} assets`, (p) => {
      let cur = p;
      for (const input of inputs) {
        const r = addAsset(cur, input);
        cur = r.project;
        ids.push(r.id);
      }
      return cur;
    });
    return ids;
  }

  /** Server only: links a local file by path (relative to the folder containing the .sbd). */
  async linkLocalFile(path: string): Promise<AssetInput> {
    const source = this.source;
    if (this.switching || !this.canEdit || !source?.linkPath)
      throw new Error('Linking local files needs a writable server project.');
    const work = source.linkPath(path, this.client);
    this.mediaWork.add(work);
    try {
      const asset = await work;
      if (this.source !== source) throw new Error('The storyboard changed while linking media.');
      return asset;
    } finally {
      this.mediaWork.delete(work);
    }
  }

  // --- notices

  toast(message: string, opts: Omit<Toast, 'id' | 'message'> = { kind: 'info' }): void {
    const t: Toast = { ...opts, id: ++this.toastId, message };
    const others = this.toasts.filter((x) => !(t.kind === 'agent' && x.kind === 'agent'));
    this.toasts = [...others.slice(-3), t];
    if (!t.sticky) setTimeout(() => this.dismissToast(t.id), t.kind === 'error' ? 7000 : 4000);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  // --- selection & variants

  setTab(tab: Tab): void {
    this.tab = tab;
    this.writeHash();
  }

  setStoryView(view: StoryView): void {
    this.storyView = view;
    setPref('story-view', view);
    this.writeHash();
  }

  /** Opens the Script view with the cursor on this line. */
  editLineInScript(id: string): void {
    this.selectLine(id, { withShot: true });
    this.revealLine = { id };
    this.setStoryView('script');
  }

  setTagFilter(tags: string[]): void {
    this.tagFilter = tags;
  }

  /** Whether a shot passes the Story tab tag filter. */
  matchesFilter(shot: Shot): boolean {
    return !this.tagFilter.length || (shot.tags ?? []).some((t) => this.tagFilter.includes(t));
  }

  selectShot(id: string | null, opts: { scroll?: boolean } = {}): void {
    this.selectedShot = id;
    this.writeHash();
    if (id && opts.scroll) {
      requestAnimationFrame(() =>
        document
          .querySelector(`[data-shot-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      );
    }
  }

  /** Selects a script line; `withShot` also selects the shot that contains it. */
  selectLine(id: string | null, opts: { withShot?: boolean } = {}): void {
    this.selectedLine = id;
    if (id && opts.withShot) {
      // a line split between shots: stay on the open shot when it is one of them
      const shots = this.project?.ids.shots ?? [];
      const open = shots.find((s) => s.id === this.selectedShot && s.lines.includes(id));
      const owner = open ?? shots.find((s) => s.lines.includes(id));
      if (owner && owner.id !== this.selectedShot) this.selectShot(owner.id);
    }
  }

  /** The variant to show for a shot: the user's choice unless the active variant changed since. */
  shownVariant(shot: Shot): Variant | undefined {
    const c = this.choices.get(shot.id);
    if (c && c.base === shot.active_variant) {
      const v = shot.variants?.find((x) => x.id === c.variant);
      if (v) return v;
    }
    return activeVariant(shot);
  }

  chooseVariant(shot: Shot, variantId: string): void {
    const next = new Map(this.choices);
    next.set(shot.id, { variant: variantId, base: shot.active_variant });
    this.choices = next;
  }

  stepVariant(shot: Shot, delta: number): void {
    const vs = shot.variants ?? [];
    if (vs.length < 2) return;
    const cur = this.shownVariant(shot);
    const i = Math.max(
      0,
      vs.findIndex((v) => v.id === cur?.id),
    );
    this.chooseVariant(shot, vs[(i + delta + vs.length) % vs.length]!.id);
  }

  mediaUrl(src: string | undefined): string | null {
    if (!src) return null;
    const info = classifySrc(src);
    if (info?.kind === 'embedded') {
      const o = this.overrides.get(info.path);
      if (o) return o;
    }
    return this.media ? this.media.url(src) : null;
  }

  mediaReason(src: string): string | null {
    const info = classifySrc(src);
    if (info?.kind === 'embedded' && this.overrides.has(info.path)) return null;
    return this.media?.reason(src) ?? 'Not available';
  }

  // --- URL hash (#tab=story&shot=climb): deep links for people and agents

  private readHash(): void {
    const params = new URLSearchParams(location.hash.slice(1));
    const tab = params.get('tab');
    if (tab && TABS.some((t) => t.id === tab)) this.tab = tab as Tab;
    else if (tab === 'timeline') {
      // The Timeline tab became the shots' Audio sections and the Soundtrack panel.
      this.tab = 'story';
      this.legacyTimeline = true;
    }
    const view = params.get('view');
    if (view === 'script' || view === 'board') this.storyView = view;
    const shot = params.get('shot');
    if (shot) this.selectShot(shot, { scroll: true });
  }

  private writeHash(): void {
    const params = new URLSearchParams();
    params.set('tab', this.tab);
    if (this.tab === 'story') params.set('view', this.storyView);
    if (this.selectedShot) params.set('shot', this.selectedShot);
    const hash = `#${params}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }
}

async function hasEntry(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

/** Dimensions / duration of a media file, probed in the browser. */
async function probeMedia(
  file: File,
  bytes: Uint8Array,
  kind: AssetKind,
): Promise<{ width?: number; height?: number; duration?: number }> {
  if (kind === 'image') {
    const dims = probeImageSize(bytes);
    if (dims) return dims;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : {};
    } catch {
      return {};
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (kind === 'audio' || kind === 'video') {
    const wav = probeWavDuration(bytes);
    if (wav !== null) return { duration: Math.round(wav * 1000) / 1000 };
    const url = URL.createObjectURL(file);
    try {
      const el = document.createElement(kind);
      el.preload = 'metadata';
      el.src = url;
      await new Promise<void>((res, rej) => {
        el.onloadedmetadata = () => res();
        el.onerror = () => rej(new Error('unreadable'));
        setTimeout(() => rej(new Error('timeout')), 5000);
      });
      const out: { width?: number; height?: number; duration?: number } = {};
      if (Number.isFinite(el.duration)) out.duration = Math.round(el.duration * 1000) / 1000;
      if (el instanceof HTMLVideoElement && el.videoWidth) {
        out.width = el.videoWidth;
        out.height = el.videoHeight;
      }
      return out;
    } catch {
      return {};
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return {};
}

export const app = new AppState();
