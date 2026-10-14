/**
 * Shared recent storyboards: a small JSON file in the user's config folder, written by every
 * `sbd serve` / `sbd mcp --serve` process. Browser storage is per origin (each port is its own
 * origin), so this file is what lets the start screen at :4401 show what was opened at :4400.
 *
 *   $SBD_CONFIG_DIR/recent.json            (tests and custom setups)
 *   $XDG_CONFIG_HOME/storyboard-viewer/recent.json
 *   ~/.config/storyboard-viewer/recent.json (default, macOS and Linux)
 *   %APPDATA%\storyboard-viewer\recent.json (Windows)
 *
 * Everything is best effort: an unreadable or unwritable file never stops a server.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Entries kept in the file (the start screen shows at most 5 after merging). */
export const MAX_SHARED_RECENT = 10;
/** Largest thumbnail data URI accepted (characters, about 20 KB of image). */
export const MAX_THUMBNAIL = 28_000;

export interface SharedRecent {
  /** Absolute path of the storyboard folder or packed file (the key). */
  path: string;
  title: string;
  kind: 'folder' | 'packed';
  /** ms since epoch */
  openedAt: number;
  /** `data:image/…;base64,…`, at most MAX_THUMBNAIL characters. */
  thumbnail?: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['SBD_CONFIG_DIR']) return env['SBD_CONFIG_DIR'];
  if (env['XDG_CONFIG_HOME']) return join(env['XDG_CONFIG_HOME'], 'storyboard-viewer');
  if (process.platform === 'win32' && env['APPDATA'])
    return join(env['APPDATA'], 'storyboard-viewer');
  return join(homedir(), '.config', 'storyboard-viewer');
}

export const recentFile = () => join(configDir(), 'recent.json');

function valid(e: unknown): e is SharedRecent {
  const r = e as SharedRecent;
  return (
    !!r &&
    typeof r.path === 'string' &&
    typeof r.title === 'string' &&
    (r.kind === 'folder' || r.kind === 'packed') &&
    typeof r.openedAt === 'number'
  );
}

/** All entries, newest first (no existence check). */
export interface RecentOptions {
  strict?: boolean;
}

export function readRecent(opts: RecentOptions = {}): SharedRecent[] {
  try {
    const data = JSON.parse(readFileSync(recentFile(), 'utf8')) as {
      version?: unknown;
      recent?: unknown[];
    };
    if (
      opts.strict &&
      (data.version !== 1 || !Array.isArray(data.recent) || !data.recent.every(valid))
    )
      throw new Error('Invalid shared history file (expected version 1 and valid recent entries).');
    return (data.recent ?? []).filter(valid).toSorted((a, b) => b.openedAt - a.openedAt);
  } catch (e) {
    if (opts.strict && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return [];
  }
}

function writeRecent(list: SharedRecent[], opts: RecentOptions = {}): void {
  try {
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    const file = recentFile();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: 1, recent: list.slice(0, MAX_SHARED_RECENT) }, null, 2)}\n`,
    );
    renameSync(tmp, file);
  } catch (e) {
    if (opts.strict) throw e;
  }
}

function update(
  fn: (list: SharedRecent[]) => SharedRecent[],
  opts: RecentOptions = {},
): SharedRecent[] {
  const before = readRecent(opts);
  const next = fn(before).toSorted((a, b) => b.openedAt - a.openedAt);
  // nothing to change: leave the file (and the config folder) alone
  if (JSON.stringify(next) !== JSON.stringify(before)) writeRecent(next, opts);
  return next;
}

/** Puts a storyboard at the top (keeps its thumbnail when it had one). */
export function recordRecent(
  entry: Omit<SharedRecent, 'openedAt'> & { openedAt?: number },
  opts: RecentOptions = {},
) {
  return update((list) => {
    const old = list.find((e) => e.path === entry.path);
    const next: SharedRecent = {
      path: entry.path,
      title: entry.title,
      kind: entry.kind,
      openedAt: entry.openedAt ?? Date.now(),
    };
    const thumb = entry.thumbnail ?? old?.thumbnail;
    if (thumb) next.thumbnail = thumb;
    return [next, ...list.filter((e) => e.path !== entry.path)];
  }, opts);
}

export function isThumbnail(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length <= MAX_THUMBNAIL &&
    /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s)
  );
}

/** Sets the picture (and optionally the title) of an existing entry; false if not listed. */
export function setRecentThumbnail(
  path: string,
  thumbnail: string,
  title?: string,
  opts: RecentOptions = {},
): boolean {
  let found = false;
  update(
    (list) =>
      list.map((e) => {
        if (e.path !== path) return e;
        found = true;
        return { ...e, thumbnail, ...(title ? { title } : {}) };
      }),
    opts,
  );
  return found;
}

export function removeRecent(path: string, opts: RecentOptions = {}): void {
  update((list) => list.filter((e) => e.path !== path), opts);
}

export function clearRecent(opts: RecentOptions = {}): void {
  if (existsSync(recentFile())) writeRecent([], opts);
}

/** One write preserves the original timestamp, thumbnail, title and unrelated entries. */
export function renameRecent(from: string, to: string, opts: RecentOptions = {}): void {
  update(
    (list) =>
      list.filter((e) => e.path !== to).map((e) => (e.path === from ? { ...e, path: to } : e)),
    opts,
  );
}
