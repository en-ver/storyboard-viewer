/**
 * ProjectStore: one storyboard on disk. Loads fresh state for every read (so hand edits are
 * always picked up), applies edit operations with validation and atomic writes, and emits change
 * events (consumed by the HTTP server's SSE stream).
 *
 * Unpacked folders get only their changed files rewritten (each atomically). Packed `.sbd`
 * files are saved in place (0.5.0): the zip is re-packed with the new text files (media kept,
 * STOREd) into a temp file next to it and renamed over it; before the first save of a session
 * the previous version is copied to `<file>.bak`.
 */
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  hasErrors,
  serializeProject,
  validateProject,
  type Issue,
  type SbdProject,
} from '@storyboard-viewer/format';
import {
  atomicWriteFile,
  backupPath,
  isIgnoredPath,
  openProjectPath,
  packedPaths,
  projectKind,
  resolveLinked,
  safeJoin,
  writeProjectToFolder,
  writeProjectToPacked,
  type OpenedProject,
  type ProjectKind,
} from '@storyboard-viewer/format/node';

import type { ProjectBoundary } from './workspace-files.js';

export interface StoreAccessPolicy {
  /** Omitted for legacy writable folder and packed stores. */
  readOnly?: boolean;
  /** Workspace-only, pinned root/project identity and real-path checks. */
  boundary?: ProjectBoundary;
}

export class EditRejectedError extends Error {
  override name = 'EditRejectedError';
  constructor(
    message: string,
    readonly issues: Issue[],
  ) {
    super(message);
  }
}

export interface EditOptions {
  /** Client that made the edit (the web app passes its client ID when saving). */
  origin?: string;
  /** Package files to add in the same write (new media), path → bytes. */
  add?: Record<string, Uint8Array>;
}

export interface ChangeEvent {
  revision: number;
  files: string[];
  source: 'edit' | 'watch';
  /** Client that made the edit (the web app passes its client ID when saving). */
  origin?: string;
}

type WatchMode = 'native' | 'per-directory';

function defaultWatchMode(): WatchMode {
  const env = process.env['SBD_WATCH'];
  if (env === 'native' || env === 'per-directory') return env;
  return process.platform === 'darwin' || process.platform === 'win32' ? 'native' : 'per-directory';
}

const issueKey = (i: Issue) => `${i.code}|${i.file ?? ''}|${i.message}`;

export class ProjectStore extends EventEmitter<{ change: [ChangeEvent] }> {
  readonly path: string;
  readonly kind: ProjectKind;
  revision = 0;
  private watcher: { close(): void } | undefined;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  /**
   * Files this process wrote, with their size+mtime right after the write. The watcher skips
   * events while a file still has that stamp (our own echo) but reports any later change, even
   * one made a few milliseconds later by another process (an agent).
   */
  private recentWrites = new Map<string, string>();
  /** Edits run one after another (a packed file is rewritten as a whole). */
  private queue: Promise<unknown> = Promise.resolve();
  /** Whether this process already kept a `.bak` of the packed file. */
  private backedUp = false;

  private retired = false;
  private retiring = false;

  private constructor(
    path: string,
    kind: ProjectKind,
    readonly access: Readonly<StoreAccessPolicy>,
  ) {
    super();
    this.path = path;
    this.kind = kind;
  }

  static open(path: string, access: StoreAccessPolicy = {}): ProjectStore {
    const abs = resolve(path);
    if (access.boundary && access.boundary.path !== abs)
      throw new Error('The workspace boundary must belong to this exact project path.');
    access.boundary?.tree();
    if (!existsSync(abs)) throw new Error(`No storyboard at ${abs}`);
    const kind = projectKind(abs);
    if (kind === 'folder' && !existsSync(resolve(abs, 'manifest.json'))) {
      throw new Error(`${abs} is not a storyboard folder (manifest.json missing)`);
    }
    return new ProjectStore(abs, kind, { ...access });
  }

  get name(): string {
    return basename(this.path);
  }

  /** Legacy stores remain writable; workspace examples and packed projects opt out. */
  get readOnly(): boolean {
    return this.access.readOnly === true;
  }

  assertActive(): void {
    if (this.retired)
      throw Object.assign(new Error('Project route retired. Reopen the project.'), {
        status: 410,
      });
    this.access.boundary?.tree();
  }

  assertWritable(): void {
    this.assertActive();
    if (this.retiring)
      throw Object.assign(new Error('Project route retiring. Reopen the project.'), {
        status: 410,
      });
    if (this.readOnly)
      throw Object.assign(new Error('This project is read-only. Copy it to Projects to edit.'), {
        status: 403,
      });
  }

  filePath(rel: string, writing = false): string {
    return this.access.boundary?.file(rel, writing) ?? safeJoin(this.path, rel);
  }

  /** Called after the HTTP admission gate drains complete saves and media requests. */
  async retire(afterDrain?: () => Promise<void>): Promise<void> {
    this.retiring = true;
    await this.queue;
    try {
      await afterDrain?.();
    } finally {
      this.retired = true;
      this.stopWatching();
    }
  }

  /** Where the previous version of a packed file is kept (null for folders). */
  get backupFile(): string | null {
    return this.kind === 'packed' ? backupPath(this.path) : null;
  }

  /** Runs `fn` after every earlier edit of this store finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Package paths that exist (unique media names). */
  async has(rel: string): Promise<boolean> {
    this.assertActive();
    if (this.kind === 'folder') return existsSync(this.filePath(rel, true));
    return (await packedPaths(this.path)).has(rel);
  }

  /**
   * Adds files to the package right away (media uploads): copied into the folder, or re-packed
   * into the packed file. `write` is called only for folders (the caller copies there).
   */
  async addFiles(files: Record<string, Uint8Array>): Promise<string[]> {
    this.assertWritable();
    if (this.kind === 'folder' && !this.access.boundary) return Object.keys(files);
    return this.serial(async () => {
      if (this.kind === 'folder') {
        this.access.boundary?.tree();
        for (const [rel, bytes] of Object.entries(files))
          await atomicWriteFile(this.filePath(rel, true), bytes);
        const written = Object.keys(files);
        this.markWritten(written);
        return written;
      }
      const opened = await this.load();
      const r = await writeProjectToPacked(this.path, opened.project, {
        add: files,
        backup: this.takeBackup(),
        touchModified: false,
      });
      this.markWritten(r.written);
      return r.written;
    });
  }

  private takeBackup(): boolean {
    if (this.backedUp) return false;
    this.backedUp = true;
    return true;
  }

  /** Loads the current state from disk (re-anchoring in memory if the script changed). */
  async load(): Promise<OpenedProject> {
    this.assertActive();
    const opened = await openProjectPath(
      this.path,
      this.access.boundary
        ? {
            linkedExists: (src) => {
              try {
                const abs = this.linkedPath(src);
                return abs ? existsSync(abs) : undefined;
              } catch {
                return false;
              } // Never probe external legacy links in workspace mode.
            },
          }
        : {},
    );
    await opened.close();
    return opened;
  }

  linkedPath(src: string): string | null {
    const abs = resolveLinked(this.path, src);
    return abs && this.access.boundary ? this.access.boundary.linked(abs) : abs;
  }

  /**
   * Applies `fn` to the current project, validates and writes. Edits that introduce new
   * validation errors are rejected (errors that existed before do not block unrelated edits).
   */
  async edit<T extends { project: SbdProject }>(
    fn: (p: SbdProject, opened: OpenedProject) => T | Promise<T>,
    opts: EditOptions = {},
  ): Promise<T & { issues: Issue[]; written: string[] }> {
    this.assertWritable();
    return this.serial(() => this.editNow(fn, opts));
  }

  private async editNow<T extends { project: SbdProject }>(
    fn: (p: SbdProject, opened: OpenedProject) => T | Promise<T>,
    opts: EditOptions,
  ): Promise<T & { issues: Issue[]; written: string[] }> {
    const opened = await this.load();
    const result = await fn(opened.project, opened);
    const files = new Set([...opened.files, ...Object.keys(opts.add ?? {})]);
    const issues = validateProject(result.project, {
      hasFile: (p) => files.has(p),
      linkedExists: (src) => {
        const abs = this.linkedPath(src);
        return abs ? existsSync(abs) : undefined;
      },
    });
    if (hasErrors(issues)) {
      const before = new Set(opened.issues.map(issueKey));
      const fresh = issues.filter((i) => i.severity === 'error' && !before.has(issueKey(i)));
      if (fresh.length) {
        throw new EditRejectedError(
          `The edit was not saved because it would make the storyboard invalid:\n${fresh.map((i) => `- ${i.message}`).join('\n')}`,
          fresh,
        );
      }
    }
    const added = Object.keys(opts.add ?? {});
    this.access.boundary?.tree();
    if (this.kind === 'folder') {
      for (const rel of Object.keys(serializeProject(result.project))) this.filePath(rel, true);
      for (const [rel, bytes] of Object.entries(opts.add ?? {}))
        await atomicWriteFile(this.filePath(rel, true), bytes);
    }
    const { written, deleted } =
      this.kind === 'folder'
        ? await writeProjectToFolder(this.path, result.project)
        : await writeProjectToPacked(this.path, result.project, {
            backup: !this.backedUp,
            ...(opts.add ? { add: opts.add } : {}),
          });
    if (this.kind === 'folder') written.unshift(...added);
    if (this.kind === 'packed' && (written.length || deleted.length)) this.backedUp = true;
    const changed = [...written, ...deleted];
    this.markWritten(changed);
    if (changed.length) this.notify(changed, 'edit', opts.origin);
    return { ...result, issues, written: changed };
  }

  /** Remembers files written by this process so the watcher skips their echo. */
  markWritten(files: readonly string[]): void {
    // a packed file is one file on disk: its own name is what the watcher reports
    if (this.kind === 'packed') files = files.length ? [basename(this.path)] : [];
    for (const f of files) {
      const stamp = this.stamp(f);
      if (stamp) this.recentWrites.set(f, stamp);
      else this.recentWrites.delete(f);
    }
  }

  private stamp(rel: string): string | null {
    try {
      this.access.boundary?.assert();
      const st = statSync(
        this.kind === 'packed'
          ? this.path
          : this.access.boundary
            ? this.filePath(rel)
            : join(this.path, rel),
      );
      return `${st.size}:${st.mtimeMs}:${st.ino}`;
    } catch {
      return 'deleted';
    }
  }

  /** Emits a change event right away (also used after media files are copied in). */
  notify(files: string[], source: ChangeEvent['source'], origin?: string): void {
    this.revision++;
    const ev: ChangeEvent = { revision: this.revision, files, source };
    if (origin) ev.origin = origin;
    this.emit('change', ev);
  }

  /**
   * Watches the folder (or packed file) and emits debounced change events.
   *
   * Folders: `fs.watch(dir, {recursive: true})` is native on macOS (FSEvents) and Windows only.
   * Elsewhere (Linux) Node ≤ 22 emulates it with one inotify watch per *file*, and a file
   * replaced by an atomic rename (how every write here and in `sbd mcp` lands) leaves that watch
   * on the old, deleted inode: the second write to the same file is never reported. So off
   * macOS/Windows each directory gets its own non-recursive watch (a directory watch reports
   * renames into it by name and survives its files being replaced), and new subfolders are
   * picked up as they appear. `SBD_WATCH=native|per-directory` overrides the choice.
   */
  startWatching(debounceMs = 120, mode: WatchMode = defaultWatchMode()): void {
    this.assertActive();
    if (this.watcher) return;
    const onEvent = (file: string | null) => {
      const rel = (file ?? '').split('\\').join('/');
      if (this.kind === 'folder' && rel && isIgnoredPath(rel)) return;
      if (this.kind === 'packed' && rel && rel !== basename(this.path)) return;
      const ours = this.recentWrites.get(rel);
      if (ours !== undefined) {
        if (this.stamp(rel) === ours) return;
        this.recentWrites.delete(rel);
      }
      this.pending.add(rel || '*');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const files = [...this.pending];
        this.pending.clear();
        this.notify(files, 'watch');
      }, debounceMs);
    };
    if (this.kind === 'folder' && mode === 'per-directory') {
      this.watcher = new DirectoryTreeWatcher(this.path, onEvent);
      return;
    }
    const w =
      this.kind === 'folder'
        ? watch(this.path, { recursive: true }, (_e, f) => onEvent(f))
        : watch(dirname(this.path), (_e, f) => onEvent(f));
    this.watcher = w;
    w.on('error', () => {
      /* folder removed etc.; keep serving the last state */
    });
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.timer);
  }
}

/**
 * A recursive folder watch built from one non-recursive `fs.watch` per directory (see
 * `startWatching`). Reports paths relative to the root with `/` separators; skips ignored
 * (dot) folders.
 */
class DirectoryTreeWatcher {
  private dirs = new Map<string, FSWatcher>();
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly onEvent: (rel: string | null) => void,
  ) {
    this.add('');
  }

  /** Watches `rel` (a folder under the root) and every folder below it. */
  private add(rel: string): void {
    if (this.closed || this.dirs.has(rel)) return;
    const abs = rel ? join(this.root, rel) : this.root;
    let w: FSWatcher;
    try {
      w = watch(abs, (_e, f) => this.onChange(rel, f));
    } catch {
      return; // gone already
    }
    w.on('error', () => this.remove(rel));
    this.dirs.set(rel, w);
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      /* removed meanwhile */
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !isIgnoredPath(child)) this.add(child);
    }
  }

  /** Stops watching `rel` and the folders below it. */
  private remove(rel: string): void {
    for (const [d, w] of this.dirs) {
      if (rel === '' || d === rel || d.startsWith(`${rel}/`)) {
        w.close();
        this.dirs.delete(d);
      }
    }
  }

  private onChange(dir: string, name: string | Buffer | null): void {
    if (this.closed) return;
    if (name == null) {
      this.onEvent(dir || null);
      return;
    }
    const rel = dir ? `${dir}/${String(name)}` : String(name);
    if (!isIgnoredPath(rel)) {
      // a folder created (or moved in) gets its own watch; a removed one is dropped
      let isDir = false;
      try {
        isDir = statSync(join(this.root, rel)).isDirectory();
      } catch {
        if (this.dirs.has(rel)) this.remove(rel);
      }
      if (isDir && !this.dirs.has(rel)) {
        this.add(rel);
        // files written into it before its watch started
        for (const f of this.filesBelow(rel)) this.onEvent(f);
      }
    }
    this.onEvent(rel);
  }

  private filesBelow(rel: string): string[] {
    try {
      return readdirSync(join(this.root, rel), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(this.root, join(e.parentPath, e.name)).split(sep).join('/'))
        .filter((f) => !isIgnoredPath(f));
    } catch {
      return [];
    }
  }

  close(): void {
    this.closed = true;
    for (const w of this.dirs.values()) w.close();
    this.dirs.clear();
  }
}
