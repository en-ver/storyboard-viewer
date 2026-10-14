/** Native workspace control plane. No global current ProjectStore or persisted route registry. */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hasErrors,
  isPresetId,
  PRESET_IDS,
  PROJECT_FILES,
  serializeProject,
  type PresetId,
} from '@storyboard-viewer/format';
import { atomicWriteFile, linkBase, resolveLinked } from '@storyboard-viewer/format/node';
import { ProjectStore } from './store.js';
import { createStoryboard } from './project-files.js';
import { createProjectHttp, type ProjectHttp } from './project-http.js';
import {
  readRecent,
  recordRecent,
  renameRecent,
  setRecentThumbnail,
  type SharedRecent,
} from './recent.js';
import { registerViewer } from './registry.js';
import type { ServeOptions } from './server.js';
import {
  ProjectBoundary,
  WorkspaceRoot,
  exampleLicensePath,
  projectName,
  rootsOverlap,
  workspaceError,
} from './workspace-files.js';

export type WorkspaceRootId = 'projects' | 'examples';
export interface WorkspaceOptions extends ServeOptions {
  workspace: string;
  examples: string;
  defaultProject?: string;
}
export interface WorkspaceEntry {
  root: WorkspaceRootId;
  name: string;
  path: string;
  title: string;
  kind: 'folder' | 'packed';
  readOnly: boolean;
}
/** URL is a same-origin path; tokens identify one loaded-store lifetime, never a document ID. */
export interface WorkspaceSelection extends WorkspaceEntry {
  token: string;
  url: string;
  warnings: string[];
}
export interface WorkspaceListing {
  mode: 'workspace';
  roots: Record<WorkspaceRootId, { label: string; path: string; readOnly: boolean }>;
  presets: readonly PresetId[];
  projects: WorkspaceEntry[];
  examples: WorkspaceEntry[];
  recent: SharedRecent[];
  initial: WorkspaceSelection;
  diagnostics: string[];
  warnings: string[];
}
interface Loaded {
  selection: WorkspaceSelection;
  store: ProjectStore;
  http: ProjectHttp;
  unregister: () => void;
  retired: boolean;
}

export const EXAMPLE_SOURCE_REVISION = '9f1f6025d9307ae5ca63654f895a69cb0f04c9ac';
export const EXAMPLE_COPY_FILES = {
  license: 'LICENSE',
  readme: 'EXAMPLES-README.md',
  source: 'SOURCE.md',
} as const;
const label = (root: WorkspaceRootId) => (root === 'projects' ? 'Projects' : 'Examples');

export class Workspace {
  readonly roots: Record<WorkspaceRootId, WorkspaceRoot>;
  initial!: WorkspaceSelection;
  private readonly loaded = new Map<string, Loaded>();
  private readonly tokens = new Map<string, Loaded>();
  private queue: Promise<unknown> = Promise.resolve();
  private origin = '';
  private closed = false;
  private readonly warnings: string[] = [];
  /** Installed by the one-listener adapter; reused for scoped legacy control endpoints. */
  control?: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    selected?: WorkspaceSelection,
  ) => Promise<boolean>;

  constructor(
    readonly opts: WorkspaceOptions,
    private readonly webRoot: string | null,
  ) {
    this.roots = {
      projects: new WorkspaceRoot(opts.workspace),
      examples: new WorkspaceRoot(opts.examples),
    };
    if (rootsOverlap(this.roots.projects, this.roots.examples))
      throw workspaceError('Projects and Examples roots must be separate and non-overlapping.');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(workspaceError('Workspace is closed.', 410));
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private history<T>(fn: () => T): { value?: T; warnings: string[] } {
    try {
      return { value: fn(), warnings: [] };
    } catch (e) {
      const message = `Shared history was not persisted/read: ${(e as Error).message}`;
      this.opts.log?.(message);
      return { warnings: [message] };
    }
  }

  recent(): { recent: SharedRecent[]; warnings: string[] } {
    const result = this.history(() => readRecent({ strict: true }));
    return {
      recent: (result.value ?? []).filter((e) => this.identify(e.path) !== null),
      warnings: result.warnings,
    };
  }

  /** Accept history paths only when they name supported immediate children of pinned roots. */
  identify(path: string): { root: WorkspaceRootId; name: string } | null {
    for (const root of ['projects', 'examples'] as const) {
      try {
        if (
          dirname(path) === this.roots[root].path &&
          this.roots[root].child(basename(path)) === path
        )
          return { root, name: basename(path) };
      } catch {
        /* Deleted, malformed or out-of-bound remembered entries stay in history. */
      }
    }
    return null;
  }

  private async inspect(
    root: WorkspaceRootId,
    name: string,
  ): Promise<{ store: ProjectStore; entry: WorkspaceEntry }> {
    const path = this.roots[root].child(name);
    const boundary = new ProjectBoundary(this.roots[root], path);
    const store = ProjectStore.open(path, {
      boundary,
      readOnly: root === 'examples' || !boundary.folder,
    });
    const opened = await store.load();
    if (hasErrors(opened.issues))
      throw workspaceError(
        `Invalid storyboard ${name}: ${opened.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('; ')}`,
      );
    return {
      store,
      entry: {
        root,
        name,
        path,
        title: opened.project.manifest.title || name,
        kind: store.kind,
        readOnly: store.readOnly,
      },
    };
  }

  private async load(
    root: WorkspaceRootId,
    name: string,
    refresh = false,
  ): Promise<WorkspaceSelection> {
    const path = this.roots[root].child(name);
    let loaded = this.loaded.get(path);
    const replacesInitial = loaded?.selection.token === this.initial?.token;
    if (loaded && refresh && !loaded.store.access.boundary!.current()) {
      // Open, not listing or an old content route, can retire a replaced project. Roots stay pinned.
      loaded.retired = true;
      this.loaded.delete(path);
      await loaded.http.retire();
      loaded.unregister();
      loaded = undefined;
    }
    if (loaded) {
      loaded.store.assertActive();
      const opened = await loaded.store.load();
      if (hasErrors(opened.issues)) throw workspaceError(`Invalid storyboard ${name}.`);
      loaded.selection.title = opened.project.manifest.title || name;
    } else {
      const { store, entry } = await this.inspect(root, name);
      const token = randomBytes(24).toString('hex');
      const selection: WorkspaceSelection = {
        ...entry,
        token,
        url: `/p/${token}/`,
        warnings: [],
      };
      const http = createProjectHttp(store, {
        ...this.opts,
        webRoot: this.webRoot,
        base: selection.url,
        workspace: { root, label: label(root) },
        viewerFor: async () => {
          throw workspaceError('Use workspace selection to open projects.');
        },
        control: async (req, res, url) => (await this.control?.(req, res, url, selection)) ?? false,
      });
      loaded = { store, selection, http, unregister: () => {}, retired: false };
      this.loaded.set(path, loaded);
      this.tokens.set(token, loaded);
      this.register(loaded);
    }
    const result =
      this.opts.recent === false
        ? { warnings: [] }
        : this.history(() =>
            recordRecent(
              { path, title: loaded.selection.title, kind: loaded.store.kind },
              { strict: true },
            ),
          );
    // Successful load precedes history writes. A warning is part of the open response, not success evidence.
    const selected = { ...loaded.selection, warnings: result.warnings };
    if (replacesInitial) this.initial = selected;
    return selected;
  }

  async startup(): Promise<WorkspaceSelection> {
    if (this.opts.defaultProject !== undefined) {
      this.initial = await this.load('projects', projectName(this.opts.defaultProject));
      return this.initial;
    }
    const history = this.recent();
    this.warnings.push(...history.warnings);
    for (const entry of history.recent) {
      const target = this.identify(entry.path);
      if (!target) continue;
      try {
        this.initial = await this.load(target.root, target.name);
        return this.initial;
      } catch (e) {
        this.opts.log?.(`Skipping recent ${entry.path}: ${(e as Error).message}`);
      }
    }
    this.initial = await this.load('examples', 'midnight-snack.sbd');
    return this.initial;
  }

  private register(loaded: Loaded): void {
    if (this.origin && this.opts.register !== false)
      loaded.unregister = registerViewer(
        loaded.store.path,
        `${this.origin}${loaded.selection.url}`,
      );
  }

  attachOrigin(origin: string): void {
    this.origin = origin.replace(/\/$/, '');
    for (const loaded of this.loaded.values()) this.register(loaded);
  }

  route(token: string): { http: ProjectHttp; retired: boolean } | undefined {
    return this.tokens.get(token);
  }
  shell(): ProjectHttp {
    return this.tokens.get(this.initial.token)!.http;
  }

  async thumbnail(selected: WorkspaceSelection, thumbnail: string): Promise<boolean> {
    if (this.opts.recent === false) return false;
    const loaded = this.tokens.get(selected.token);
    if (!loaded || loaded.retired)
      throw workspaceError('Project route retired. Reopen the project.', 410);
    const opened = await loaded.store.load();
    loaded.store.assertActive();
    if (loaded.retired) throw workspaceError('Project route retired. Reopen the project.', 410);
    return setRecentThumbnail(loaded.store.path, thumbnail, opened.project.manifest.title, {
      strict: true,
    });
  }

  open(root: WorkspaceRootId, name: string): Promise<WorkspaceSelection> {
    return this.serial(() => this.load(root, projectName(name), true));
  }

  listing(): Promise<WorkspaceListing> {
    return this.serial(async () => {
      const groups: Record<WorkspaceRootId, WorkspaceEntry[]> = { projects: [], examples: [] };
      const diagnostics: string[] = [];
      for (const root of ['projects', 'examples'] as const) {
        this.roots[root].assert();
        for (const name of readdirSync(this.roots[root].path).toSorted()) {
          if (!name.endsWith('.sbd')) continue;
          try {
            groups[root].push((await this.inspect(root, name)).entry);
          } catch (e) {
            diagnostics.push(`${label(root)}/${name}: ${(e as Error).message}`);
          }
        }
      }
      const recent = this.recent();
      return {
        mode: 'workspace',
        roots: {
          projects: { label: 'Projects', path: this.roots.projects.path, readOnly: false },
          examples: { label: 'Examples', path: this.roots.examples.path, readOnly: true },
        },
        presets: PRESET_IDS,
        ...groups,
        recent: recent.recent,
        initial: this.initial,
        diagnostics,
        warnings: [...this.warnings, ...recent.warnings, ...this.initial.warnings],
      };
    });
  }

  create(name: string, title?: string, preset: PresetId = 'blank'): Promise<WorkspaceSelection> {
    return this.serial(async () => {
      if (!isPresetId(preset)) throw workspaceError('Unknown preset.');
      const path = this.destination(name);
      await mkdir(path, { mode: 0o755 });
      await createStoryboard(path, { title: title ?? basename(name, '.sbd'), preset });
      return this.load('projects', name);
    });
  }

  private destination(name: string): string {
    const path = this.roots.projects.child(name, true);
    if (existsSync(path)) throw workspaceError(`Project already exists: ${name}`, 409);
    return path;
  }

  copy(example: string, name: string): Promise<WorkspaceSelection> {
    return this.serial(async () => {
      const { store } = await this.inspect('examples', projectName(example));
      if (store.kind !== 'folder') throw workspaceError('Copy requires an unpacked example.');
      // Rights inputs are fixed trusted package paths, never request-supplied filenames.
      const parent = new WorkspaceRoot(dirname(this.roots.examples.path));
      const license = await readFile(parent.check(exampleLicensePath(this.roots.examples)));
      const readme = await readFile(
        this.roots.examples.check(join(this.roots.examples.path, 'README.md')),
      );
      for (const file of Object.values(EXAMPLE_COPY_FILES))
        if (existsSync(store.filePath(file, true)))
          throw workspaceError(`Example already contains reserved copy evidence: ${file}`);
      const dest = this.destination(projectName(name));
      await mkdir(dest, { mode: 0o755 });
      const copy = async (source: string, target: string) => {
        for (const ent of readdirSync(source, { withFileTypes: true })) {
          const from = this.roots.examples.check(join(source, ent.name));
          const to = this.roots.projects.check(join(target, ent.name), true);
          if (ent.isDirectory()) {
            await mkdir(to, { mode: 0o755 });
            await copy(from, to);
          } else if (ent.isFile())
            await writeFile(to, await readFile(from), { flag: 'wx', mode: 0o644 });
          else throw workspaceError('Unsupported example file.');
        }
      };
      await copy(store.path, dest);
      await writeFile(join(dest, EXAMPLE_COPY_FILES.license), license, {
        flag: 'wx',
        mode: 0o644,
      });
      await writeFile(join(dest, EXAMPLE_COPY_FILES.readme), readme, {
        flag: 'wx',
        mode: 0o644,
      });
      await writeFile(
        join(dest, EXAMPLE_COPY_FILES.source),
        `# Example source\n\nCopied from examples/${example} in Storyboard Viewer.\nSource revision: ${EXAMPLE_SOURCE_REVISION}.\nOriginal project bytes, IDs, title and assets are preserved.\nSee LICENSE and EXAMPLES-README.md for the original notice and publisher provenance.\n`,
        { flag: 'wx', mode: 0o644 },
      );
      return this.load('projects', name);
    });
  }

  rename(token: string, name: string, externalWritersPaused: boolean): Promise<WorkspaceSelection> {
    return this.serial(async () => {
      if (!externalWritersPaused)
        throw workspaceError(
          'Pause cooperating external writers before rename; independent MCP sessions must reopen the new path.',
        );
      const loaded = this.tokens.get(token);
      if (!loaded || loaded.retired)
        throw workspaceError('Project route retired. Reopen the project.', 410);
      if (
        loaded.selection.root !== 'projects' ||
        loaded.store.kind !== 'folder' ||
        loaded.store.readOnly
      )
        throw workspaceError('Only writable unpacked Projects can be renamed.', 403);
      const dest = this.destination(projectName(name));
      const old = loaded.store.path;
      loaded.retired = true;
      this.loaded.delete(old);
      // Stop admission synchronously, then drain all complete HTTP writes (including uploads),
      // the store edit queue and saves. This is not a cross-process lock.
      let assetsText: string | undefined;
      try {
        await loaded.http.retire(async () => {
          const opened = await loaded.store.load();
          if (hasErrors(opened.issues))
            throw workspaceError(`Invalid storyboard ${loaded.selection.name}.`);
          let changed = false;
          const rebase = (src: string): string => {
            const abs = resolveLinked(old, src);
            if (!abs) return src;
            let own: string;
            try {
              own = loaded.store.access.boundary!.linked(abs);
            } catch {
              return src; // External references are never rewritten or probed.
            }
            changed = true;
            const moved = join(dest, relative(old, own));
            return `file:${relative(linkBase(dest), moved).split(sep).join('/')}`;
          };
          const assets = {
            ...opened.project.assets,
            assets: opened.project.assets.assets.map((asset) => ({
              ...asset,
              src: rebase(asset.src),
              ...(asset.poster === undefined ? {} : { poster: rebase(asset.poster) }),
              ...(asset.variants === undefined
                ? {}
                : {
                    variants: asset.variants.map((variant) => ({
                      ...variant,
                      src: rebase(variant.src),
                    })),
                  }),
            })),
          };
          if (changed)
            assetsText = serializeProject({ ...opened.project, assets })[PROJECT_FILES.assets];
        });
      } finally {
        loaded.unregister();
      }
      loaded.store.access.boundary!.tree();
      this.roots.projects.check(dest, true);
      await rename(old, dest);
      if (assetsText !== undefined) {
        const boundary = new ProjectBoundary(this.roots.projects, dest);
        boundary.tree();
        await atomicWriteFile(boundary.file(PROJECT_FILES.assets, true), assetsText);
      }
      const history = this.history(() => renameRecent(old, dest, { strict: true }));
      const selected = await this.load('projects', name);
      selected.warnings.push(...history.warnings);
      if (this.initial.token === token) this.initial = selected;
      return selected;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    await Promise.all(
      [...this.tokens.values()].map(async (loaded) => {
        loaded.unregister();
        if (!loaded.retired) {
          loaded.retired = true;
          await loaded.http.retire();
        }
      }),
    );
    this.loaded.clear();
  }
}
