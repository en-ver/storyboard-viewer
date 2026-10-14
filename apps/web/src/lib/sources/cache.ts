/**
 * Recent storyboards (IndexedDB, per browser and per origin): the last few storyboards opened
 * here, for one-click reopening from the start screen.
 * - `server`: a storyboard served by `sbd serve` (reopened by going to its URL),
 * - `folder`: a folder opened with the File System Access API (the directory handle is kept;
 *   permission is asked again on click),
 * - `zip`: a packed .sbd (a copy of its bytes is kept as the working copy, so it reopens offline).
 * Each entry has a small thumbnail of the first shot's picture. Everything is wrapped in
 * try/catch: storage can be unavailable (private mode, quota) and reopening is a convenience.
 */
const DB = 'storyboard-viewer';
const STORE = 'recent';
/** Before 0.4.0 only one entry was kept, under this key. */
const LEGACY_KEY = 'last';
const PREFIX = 'r:';
/** Thumbnails live in their own records, so updating one never rewrites an entry's handle. */
const THUMB = 't:';
export const MAX_RECENT = 5;

/**
 * `served`: from the shared list kept by `sbd serve` in the user's config folder (GET
 * /api/recent), reopened through POST /api/open; the others live in this origin's IndexedDB.
 */
export type RecentKind = 'server' | 'folder' | 'zip' | 'served';

export interface RecentEntry {
  /** Stable key: the same storyboard opened again replaces its entry. */
  id: string;
  kind: RecentKind;
  /** Storyboard title. */
  title: string;
  /** File or folder name. */
  name: string;
  /** Where it came from, in words ("localhost:4400 · story.sbd", "Folder", ".sbd file"). */
  location: string;
  openedAt: number;
  /** Server: the viewer URL to go back to. */
  url?: string;
  /** Server: the storyboard's path on disk (shown as a tooltip). */
  path?: string;
  /** A small picture of the first shot. */
  thumb?: Blob;
  /** The same as a data URI (shared entries). */
  thumbUrl?: string;
  /** Packed bytes (packed files: the working copy). */
  blob?: Blob;
  handle?: FileSystemDirectoryHandle;
  /** Packed files opened through the file picker: reopened (and saved) in place. */
  fileHandle?: FileSystemFileHandle;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  try {
    const t = db.transaction(STORE, mode);
    const out = await fn(t.objectStore(STORE));
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    return out;
  } finally {
    db.close();
  }
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

interface LegacyEntry {
  name: string;
  kind: 'zip' | 'folder';
  savedAt: number;
  blob: Blob;
  handle?: FileSystemDirectoryHandle;
}

/** All recent storyboards, newest first (at most MAX_RECENT). */
export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const all = await withStore('readwrite', async (s) => {
      const keys = (await req(s.getAllKeys())) as IDBValidKey[];
      const out: RecentEntry[] = [];
      for (const k of keys) {
        const v = await req(s.get(k));
        if (k === LEGACY_KEY && v) {
          // one-time move of the 0.3 "last file" entry into the list
          const old = v as LegacyEntry;
          const entry: RecentEntry = {
            id: `${old.kind}:${old.name}`,
            kind: old.kind,
            title: old.name.replace(/\.sbd$/i, ''),
            name: old.name,
            location: old.kind === 'zip' ? '.sbd file' : 'Folder',
            openedAt: old.savedAt,
            blob: old.blob,
          };
          if (old.handle) entry.handle = old.handle;
          s.put(entry, PREFIX + entry.id);
          s.delete(LEGACY_KEY);
          out.push(entry);
        } else if (typeof k === 'string' && k.startsWith(PREFIX) && v) out.push(v as RecentEntry);
      }
      for (const e of out) {
        const t = (await req(s.get(THUMB + e.id))) as Blob | undefined;
        if (t) e.thumb = t;
      }
      return out;
    });
    return all.toSorted((a, b) => b.openedAt - a.openedAt).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Adds or refreshes an entry; keeps the newest MAX_RECENT. */
export async function putRecent(entry: RecentEntry): Promise<void> {
  try {
    await withStore('readwrite', async (s) => {
      const { thumb, ...rest } = entry;
      s.put(rest, PREFIX + entry.id);
      if (thumb) s.put(thumb, THUMB + entry.id);
      const keys = ((await req(s.getAllKeys())) as IDBValidKey[]).filter(
        (k): k is string => typeof k === 'string' && k.startsWith(PREFIX),
      );
      if (keys.length <= MAX_RECENT) return;
      // drop the oldest
      const items: Array<{ id: string; openedAt: number }> = [];
      for (const k of keys) {
        const v = (await req(s.get(k))) as RecentEntry;
        items.push({ id: v.id, openedAt: v.openedAt });
      }
      items.sort((a, b) => b.openedAt - a.openedAt);
      for (const old of items.slice(MAX_RECENT)) {
        s.delete(PREFIX + old.id);
        s.delete(THUMB + old.id);
      }
    });
  } catch {
    /* storage unavailable: reopening is a convenience */
  }
}

/** Stores the small picture shown for an entry. */
export async function putThumb(id: string, thumb: Blob): Promise<void> {
  try {
    await withStore('readwrite', (s) => {
      s.put(thumb, THUMB + id);
    });
  } catch {
    /* ignore */
  }
}

export async function removeRecent(id: string): Promise<void> {
  try {
    await withStore('readwrite', (s) => {
      s.delete(PREFIX + id);
      s.delete(THUMB + id);
    });
  } catch {
    /* ignore */
  }
}

export async function clearRecent(): Promise<void> {
  try {
    await withStore('readwrite', (s) => {
      s.clear();
    });
  } catch {
    /* ignore */
  }
}

/** Entry of the shared list (GET /api/recent). */
export interface SharedRecent {
  path: string;
  title: string;
  kind: 'folder' | 'packed';
  openedAt: number;
  thumbnail?: string;
}

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function sharedToEntry(s: SharedRecent): RecentEntry {
  const name = fileName(s.path);
  const entry: RecentEntry = {
    id: `served:${s.path}`,
    kind: 'served',
    title: s.title || name,
    name,
    location: `${s.kind === 'packed' ? '.sbd file' : 'Folder'} · ${name}`,
    openedAt: s.openedAt,
    path: s.path,
  };
  if (s.thumbnail) entry.thumbUrl = s.thumbnail;
  return entry;
}

/**
 * One list for the start screen: the shared server list plus this browser's entries (dropped
 * files, folder handles, servers on other ports), newest first, one entry per storyboard path
 * (a shared entry wins over a browser entry for the same path, with the later time), at most
 * `max`.
 */
export function mergeRecents(
  local: RecentEntry[],
  shared: SharedRecent[],
  max = MAX_RECENT,
): RecentEntry[] {
  const all = [...shared.map(sharedToEntry), ...local];
  const byKey = new Map<string, RecentEntry>();
  for (const e of all) {
    const key = e.path ? `path:${e.path}` : `id:${e.id}`;
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, e);
      continue;
    }
    // the shared entry stays (it reopens from any port), opened at the later of the two times,
    // with this browser's picture when the shared list has none yet
    const merged = { ...kept, openedAt: Math.max(kept.openedAt, e.openedAt) };
    if (!merged.thumbUrl && !merged.thumb && e.thumb) merged.thumb = e.thumb;
    byKey.set(key, merged);
  }
  return [...byKey.values()].toSorted((a, b) => b.openedAt - a.openedAt).slice(0, max);
}

/** The shared list from `sbd serve` on this origin; [] when not served by it. */
type ReportWarnings = (warnings: string[]) => void;

export async function fetchSharedRecent(
  base = '',
  report?: ReportWarnings,
): Promise<SharedRecent[]> {
  try {
    const res = await fetch(`${base}/api/recent`, { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return [];
    const body = (await res.json()) as { recent?: SharedRecent[]; warnings?: string[] };
    report?.(body.warnings ?? []);
    return Array.isArray(body.recent) ? body.recent : [];
  } catch (e) {
    report?.([`Could not read shared history: ${(e as Error).message}`]);
    return [];
  }
}

const write = (url: string, client: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-sbd-client': client },
  });

/** Removes one shared entry (by path) or, without a path, clears the shared list. */
export async function forgetShared(
  client: string,
  path?: string,
  base = '',
  report?: ReportWarnings,
): Promise<void> {
  try {
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await write(`${base}/api/recent${q}`, client, { method: 'DELETE' });
    const body = (await res.json()) as { error?: string; warnings?: string[] };
    if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`);
    report?.(body.warnings ?? []);
  } catch (e) {
    report?.([`Could not update shared history: ${(e as Error).message}`]);
  }
}

/** Gives the server the small picture for the storyboard it serves. */
export async function putSharedThumb(
  client: string,
  thumb: Blob,
  base = '',
  report?: ReportWarnings,
): Promise<void> {
  try {
    const thumbnail = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(thumb);
    });
    if (thumbnail.length > 28_000) return;
    const res = await write(`${base}/api/recent/thumbnail`, client, {
      method: 'PUT',
      body: JSON.stringify({ thumbnail }),
    });
    const body = (await res.json()) as { error?: string; warnings?: string[] };
    if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`);
    report?.(body.warnings ?? []);
  } catch (e) {
    report?.([`Could not remember the thumbnail: ${(e as Error).message}`]);
  }
}

/** Asks for a viewer; the current storyboard reopens at the requesting origin's root. */
export async function openShared(
  client: string,
  path: string,
  base = '',
  report?: ReportWarnings,
): Promise<string> {
  const res = await write(`${base}/api/open`, client, {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    url?: string;
    current?: boolean;
    error?: string;
    warnings?: string[];
  };
  if (!res.ok || !body.url) throw new Error(body.error ?? `Server error ${res.status}`);
  report?.(body.warnings ?? []);
  if (body.url.startsWith('/p/')) return body.url;
  // The server's advertised URL can use a container's hostname or internal port.
  if (body.current === true) {
    return base ? new URL('/', new URL(base, globalThis.location?.href)).href : '/';
  }
  return body.url;
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", or a date. */
export function timeAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString();
}
