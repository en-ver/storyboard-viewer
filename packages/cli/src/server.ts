/**
 * `sbd serve`: one localhost server for the built web app and one storyboard.
 *
 *   GET /api/health            {ok, app, version, path, name, kind}
 *   GET /api/project           project JSON + issues + media index + source info
 *   GET /api/events            Server-Sent Events: `change` {revision, files}
 *   GET /api/files/<path>      package file (embedded media), HTTP Range supported
 *   GET /api/linked?src=file:… linked media referenced by assets.json, HTTP Range supported
 *   GET /api/download          the storyboard as a packed .sbd
 *   PUT /api/project           save text files from the web app (optimistic concurrency, below)
 *   POST /api/media?name=…     upload a media file into media/ (returns an asset entry to add)
 *   POST /api/link             {path} → asset entry for a linked local file (`file:` src)
 *   GET /api/recent            shared recent storyboards (see recent.ts), newest first
 *   DELETE /api/recent[?path=] remove one entry (or clear the list)
 *   PUT /api/recent/thumbnail  {thumbnail: data URI} → the picture for this server's storyboard
 *   POST /api/open             {path} (a path from the recent list) → {url} of a viewer for it:
 *                              an already running one, or a new server started by this process
 *   GET /*                     the web app (SPA fallback to index.html, marked as served)
 *
 * Writes need the `x-sbd-client` header (a custom header forces a CORS preflight, which this
 * server never approves, so other websites cannot write) and a same-origin `Origin` if any.
 */
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  fileVersion,
  loadProject,
  mimeForPath,
  packSbd,
  readZipEntry,
  serializeProject,
  treeReader,
  type ZipEntry,
} from '@storyboard-viewer/format';
import { linkBase, readFolderTree, safeJoin, zipFileReader } from '@storyboard-viewer/format/node';
import { prepareAsset } from './media-import.js';
import { EditRejectedError, ProjectStore } from './store.js';
import { findViewer, registerViewer } from './registry.js';
import {
  clearRecent,
  isThumbnail,
  readRecent,
  recentFile,
  recordRecent,
  removeRecent,
  setRecentThumbnail,
} from './recent.js';
import { VERSION } from './version.js';

export interface ServeOptions {
  port?: number;
  host?: string;
  /** Directory with the built web app; auto-detected when omitted. */
  webRoot?: string | null;
  watch?: boolean;
  /** List this server for `get_viewer_url` (default true; off for short-lived export servers). */
  register?: boolean;
  /**
   * Put this storyboard on the shared recent list in the user's config folder (`sbd serve` and
   * `sbd mcp --serve`; off by default so tests and short-lived export servers leave it alone).
   */
  recent?: boolean;
  log?: (msg: string) => void;
}

export interface RunningServer {
  url: string;
  /** With `--host 0.0.0.0` (or `::`): the same viewer at this computer's network addresses. */
  networkUrls: string[];
  port: number;
  server: Server;
  close(): Promise<void>;
}

/** Built web app: bundled into the CLI package (`web/`), or the workspace build in a checkout. */
export function findWebRoot(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const candidate of [join(here, '../web'), join(here, '../../../apps/web/dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate);
  }
  return null;
}

const TEXT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.fountain': 'text/plain; charset=utf-8',
};

/** Added to the app's index.html (the web app checks for it before calling /api). */
const SERVED_MARKER = '<meta name="sbd-serve" content="1" />';

function contentType(path: string): string {
  return TEXT_TYPES[extname(path).toLowerCase()] ?? mimeForPath(path);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

interface Range {
  start: number;
  end: number; // inclusive
}

function parseRange(header: string | undefined, size: number): Range | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/**
 * Sends `size` bytes produced by `open(start, end)` honoring Range. `etag` enables 304s.
 */
function sendRanged(
  req: IncomingMessage,
  res: ServerResponse,
  size: number,
  type: string,
  etag: string,
  open: (start: number, endInclusive: number) => NodeJS.ReadableStream,
): void {
  const headers: Record<string, string | number> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'no-cache',
  };
  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers['content-length'] = size === 0 ? 0 : end - start + 1;
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = open(start, end);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function sendFileRanged(req: IncomingMessage, res: ServerResponse, abs: string): void {
  let st;
  try {
    st = statSync(abs);
  } catch {
    sendError(res, 404, 'Not found');
    return;
  }
  if (!st.isFile()) {
    sendError(res, 404, 'Not found');
    return;
  }
  sendRanged(
    req,
    res,
    st.size,
    contentType(abs),
    `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`,
    (start, end) => createReadStream(abs, { start, end }),
  );
}

async function sendZipEntry(
  req: IncomingMessage,
  res: ServerResponse,
  zipPath: string,
  name: string,
): Promise<void> {
  const reader = await zipFileReader(zipPath);
  try {
    const entry = reader.entry(name);
    if (!entry) {
      sendError(res, 404, 'Not found');
      return;
    }
    const etag = `"${entry.crc32.toString(36)}-${entry.size.toString(36)}"`;
    if (entry.method === 0) {
      const base = entry.dataStart;
      sendRanged(req, res, entry.size, contentType(name), etag, (start, end) =>
        createReadStream(zipPath, { start: base + start, end: base + end }),
      );
    } else {
      const data = await readZipEntry(reader.source, entry as ZipEntry);
      sendRanged(req, res, data.length, contentType(name), etag, (start, end) =>
        Readable.from([Buffer.from(data.subarray(start, end + 1))]),
      );
    }
  } finally {
    await reader.close();
  }
}

/** Text files the web app may write through PUT /api/project. */
const WRITABLE =
  /^(manifest\.json|ids\.json|assets\.json|timeline\.json|script\.fountain|shots\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.json)$/;

class SaveConflict extends Error {
  constructor(readonly paths: string[]) {
    super(`Changed on disk since you loaded it: ${paths.join(', ')}`);
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Rejects cross-site writes: custom header required, Origin (when sent) must match Host. */
function writeAllowed(req: IncomingMessage): boolean {
  if (!req.headers['x-sbd-client']) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export async function startServer(
  store: ProjectStore,
  opts: ServeOptions = {},
): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  const webRoot = opts.webRoot === undefined ? findWebRoot() : opts.webRoot;
  const clients = new Set<ServerResponse>();

  const onChange = (ev: { revision: number; files: string[]; origin?: string }) => {
    const data = { revision: ev.revision, files: ev.files, origin: ev.origin ?? null };
    const msg = `event: change\nid: ${ev.revision}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
    log(`change r${ev.revision}: ${ev.files.join(', ')}`);
  };
  store.on('change', onChange);
  if (opts.watch !== false) store.startWatching();
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 20_000);

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const path = url.pathname;
    if (path === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        app: 'sbd',
        version: VERSION,
        path: store.path,
        name: store.name,
        kind: store.kind,
      });
      return;
    }
    if (path === '/api/project') {
      const opened = await store.load();
      const media: Record<string, { size: number; mtime: number }> = {};
      if (store.kind === 'folder') {
        for (const f of opened.files) {
          if (!f.startsWith('media/')) continue;
          try {
            const st = statSync(join(store.path, f));
            media[f] = { size: st.size, mtime: Math.floor(st.mtimeMs) };
          } catch {
            /* raced with a delete */
          }
        }
      } else {
        // version by content (CRC), not the file's mtime: saving the .sbd must not make every
        // picture reload
        const reader = await zipFileReader(store.path);
        try {
          for (const f of opened.files) {
            const e = f.startsWith('media/') ? reader.entry(f) : undefined;
            if (e) media[f] = { size: e.size, mtime: e.crc32 };
          }
        } finally {
          await reader.close();
        }
      }
      sendJson(res, 200, {
        project: opened.project,
        issues: opened.issues,
        files: opened.files,
        media,
        reanchor: opened.reanchor ?? null,
        revision: store.revision,
        source: { kind: store.kind, name: store.name, path: store.path, readOnly: store.readOnly },
      });
      return;
    }
    if (path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(
        `retry: 1000\nevent: hello\ndata: ${JSON.stringify({ revision: store.revision })}\n\n`,
      );
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path.startsWith('/api/files/')) {
      const rel = decodeURIComponent(path.slice('/api/files/'.length));
      if (store.kind === 'folder') {
        let abs: string;
        try {
          abs = safeJoin(store.path, rel);
        } catch {
          sendError(res, 400, 'Invalid path');
          return;
        }
        sendFileRanged(req, res, abs);
      } else {
        await sendZipEntry(req, res, store.path, rel);
      }
      return;
    }
    if (path === '/api/linked') {
      const src = url.searchParams.get('src') ?? '';
      const opened = await store.load();
      const referenced = opened.project.assets.assets.some(
        (a) => a.src === src || a.poster === src || a.variants?.some((v) => v.src === src),
      );
      if (!referenced) {
        sendError(res, 403, 'Only files referenced by assets.json can be served');
        return;
      }
      const abs = store.linkedPath(src);
      if (!abs) {
        sendError(res, 400, 'Not a file: source');
        return;
      }
      sendFileRanged(req, res, abs);
      return;
    }
    if (path === '/api/recent') {
      sendJson(res, 200, {
        recent: readRecent().filter((e) => existsSync(e.path)),
        current: store.path,
        file: recentFile(),
      });
      return;
    }
    if (path === '/api/download') {
      const filename = store.name.endsWith('.sbd') ? store.name : `${store.name}.sbd`;
      const headers = {
        'content-type': 'application/vnd.sbd+zip',
        'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'cache-control': 'no-store',
      };
      if (store.kind === 'packed') {
        res.writeHead(200, headers);
        createReadStream(store.path).pipe(res);
      } else {
        const zip = packSbd(await readFolderTree(store.path));
        res.writeHead(200, { ...headers, 'content-length': zip.length });
        res.end(zip);
      }
      return;
    }
    sendError(res, 404, `Unknown API endpoint ${path}`);
  };

  const handleStatic = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!webRoot) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><title>sbd serve</title><p>The web app is not built. Run <code>pnpm build</code> in the storyboard-viewer repo.</p><p>API: <a href="/api/project">/api/project</a></p>`,
      );
      return;
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    let abs = resolve(webRoot, rel);
    if (!abs.startsWith(webRoot + sep) || !existsSync(abs) || !statSync(abs).isFile()) {
      if (extname(rel)) {
        sendError(res, 404, 'Not found');
        return;
      }
      abs = join(webRoot, 'index.html');
    }
    // Only files with a content hash in their name (assets/) may be cached for good. Everything
    // else (index.html, sw.js, the manifest, icons, bundled examples) is revalidated each time,
    // so a rebuilt app reaches the browser and its service worker sees the new version.
    const hashed = relative(webRoot, abs).split(sep)[0] === 'assets';
    let body = await readFile(abs);
    // Tells the app it is served by `sbd serve`, so it talks to /api; a hosted copy of the app
    // (any other static server) has no marker and never calls /api.
    if (abs.endsWith('index.html'))
      body = Buffer.from(body.toString('utf8').replace(/<head>/i, `<head>${SERVED_MARKER}`));
    res.writeHead(200, {
      'content-type': contentType(abs),
      'content-length': body.length,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const handleWrite = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const path = url.pathname;
    if (!writeAllowed(req)) {
      sendError(res, 403, 'Writes must come from the Storyboard Viewer app on this server');
      return;
    }
    if (path === '/api/recent' && req.method === 'DELETE') {
      const which = url.searchParams.get('path');
      if (which) removeRecent(which);
      else clearRecent();
      sendJson(res, 200, { ok: true, recent: readRecent() });
      return;
    }
    if (path === '/api/recent/thumbnail' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as {
        thumbnail?: unknown;
      };
      if (!isThumbnail(body.thumbnail)) {
        sendError(res, 400, 'thumbnail must be a small image data URI');
        return;
      }
      // only servers that keep the list (not tests, PDF export or other short-lived servers)
      if (!opts.recent) {
        sendJson(res, 200, { ok: false });
        return;
      }
      const title = (await store.load()).project.manifest.title;
      sendJson(res, 200, { ok: setRecentThumbnail(store.path, body.thumbnail, title) });
      return;
    }
    if (path === '/api/open' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as {
        path?: unknown;
      };
      const target = typeof body.path === 'string' ? body.path : '';
      // only storyboards from the shared recent list (or this one): no arbitrary paths
      if (target !== store.path && !readRecent().some((e) => e.path === target)) {
        sendError(res, 403, 'Only storyboards from the recent list can be opened');
        return;
      }
      if (!existsSync(target)) {
        sendError(res, 404, `No storyboard at ${target} any more`);
        return;
      }
      sendJson(res, 200, { url: await viewerFor(target) });
      return;
    }
    const client = String(req.headers['x-sbd-client']);
    if (path === '/api/project' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8')) as {
        changes?: Record<string, string | null>;
        base?: Record<string, string | null>;
      };
      const changes = body.changes ?? {};
      const base = body.base ?? {};
      for (const p of Object.keys(changes)) {
        if (
          !WRITABLE.test(p) ||
          (changes[p] === null && p !== 'script.fountain' && !p.startsWith('shots/'))
        ) {
          sendError(res, 400, `Cannot write ${p}`);
          return;
        }
      }
      try {
        const result = await store.edit(
          async (current) => {
            const files = serializeProject(current);
            const conflicts = Object.keys(changes).filter((p) => {
              const cur = files[p] ?? null;
              return cur !== changes[p] && fileVersion(cur) !== (base[p] ?? null);
            });
            if (conflicts.length) throw new SaveConflict(conflicts);
            const next: Record<string, string> = { ...files };
            for (const [p, text] of Object.entries(changes)) {
              if (text === null) delete next[p];
              else next[p] = text;
            }
            const enc = new TextEncoder();
            const tree = Object.fromEntries(
              Object.entries(next).map(([k, v]) => [k, enc.encode(v)]),
            );
            const loaded = await loadProject(treeReader(tree), { skipValidation: true });
            return { project: loaded.project };
          },
          { origin: client },
        );
        const opened = await store.load();
        sendJson(res, 200, {
          ok: true,
          written: result.written,
          revision: store.revision,
          project: opened.project,
          issues: opened.issues,
        });
      } catch (e) {
        if (e instanceof SaveConflict) sendJson(res, 409, { error: e.message, conflicts: e.paths });
        else if (e instanceof EditRejectedError)
          sendJson(res, 422, { error: e.message, issues: e.issues });
        else throw e;
      }
      return;
    }
    if (path === '/api/media' && req.method === 'POST') {
      const name = basename(url.searchParams.get('name') ?? 'file').replace(/[^\w.\- ]+/g, '_');
      const dir = await mkdtemp(join(tmpdir(), 'sbd-upload-'));
      try {
        const tmp = join(dir, name || 'file');
        let size = 0;
        const limit = 4 * 1024 * 1024 * 1024;
        await pipeline(
          req,
          async function* (src: AsyncIterable<Buffer>) {
            for await (const chunk of src) {
              size += chunk.length;
              if (size > limit) throw Object.assign(new Error('File too large'), { status: 413 });
              yield chunk;
            }
          },
          createWriteStream(tmp),
        );
        const input: Parameters<typeof prepareAsset>[1] = { path: tmp, mode: 'embed' };
        const stem = url.searchParams.get('stem');
        if (stem) input.name = stem;
        if (store.kind === 'packed') {
          // re-packed into the .sbd right away (the asset entry is saved with the next edit)
          const { asset, created, files } = await prepareAsset(store.path, input, {
            packed: { exists: (rel) => store.has(rel) },
          });
          await store.addFiles(files);
          sendJson(res, 200, { asset, created });
        } else {
          const { asset, created } = await prepareAsset(store.path, input);
          store.markWritten(created);
          sendJson(res, 200, { asset, created });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }
    if (path === '/api/link' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as {
        path?: string;
      };
      const raw = (body.path ?? '').trim().replace(/^file:(\/\/)?/, '');
      if (!raw) {
        sendError(res, 400, 'Give the path of a local file');
        return;
      }
      const abs = isAbsolute(raw) ? raw : resolve(linkBase(store.path), raw);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        sendError(res, 404, `No file at ${abs}`);
        return;
      }
      const { asset } = await prepareAsset(store.path, { path: abs, mode: 'link' });
      sendJson(res, 200, { asset });
      return;
    }
    sendError(res, 405, 'Method not allowed');
  };

  /** Servers this one started for other storyboards (POST /api/open); closed with it. */
  const others = new Map<string, RunningServer>();
  let selfUrl = '';
  /**
   * A viewer URL for a storyboard: this server, one already running (any process), or a new
   * server in this process on the next free port. Switching what this server serves was
   * rejected: an agent (`sbd mcp --serve`) and other tabs would suddenly see another project.
   */
  const viewerFor = async (target: string): Promise<string> => {
    if (target === store.path) return selfUrl;
    const mine = others.get(target);
    if (mine) return mine.url;
    const live = await findViewer(target);
    if (live) return live;
    const next = ProjectStore.open(target);
    // next to this server's port (port 0, as in tests: any free port)
    const base = opts.port ?? 4400;
    const ports = base === 0 ? [0] : Array.from({ length: 40 }, (_, i) => base + 1 + i);
    let lastError: unknown;
    for (const port of ports) {
      try {
        const srv = await startServer(next, { ...opts, port });
        others.set(target, srv);
        log(`opened ${target} at ${srv.url}`);
        return srv.url;
      } catch (e) {
        lastError = e;
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('No free port');
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      handleWrite(req, res, url).catch((e: Error & { status?: number }) => {
        log(`error ${req.method} ${url.pathname}: ${e.message}`);
        if (!res.headersSent)
          sendError(res, e.status ?? (e instanceof SyntaxError ? 400 : 500), e.message);
        else res.destroy();
      });
      return;
    }
    const handler = url.pathname.startsWith('/api/') ? handleApi : handleStatic;
    handler(req, res, url).catch((e: Error) => {
      log(`error ${url.pathname}: ${e.message}`);
      if (!res.headersSent) sendError(res, 500, e.message);
      else res.destroy();
    });
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4400, host, () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  const shownHost =
    host === '127.0.0.1' || host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${shownHost}:${port}/`;
  const networkUrls = host === '0.0.0.0' || host === '::' ? lanUrls(port) : [];
  selfUrl = url;
  const unregister = opts.register === false ? () => {} : registerViewer(store.path, url);
  if (opts.recent) {
    try {
      const opened = await store.load();
      recordRecent({
        path: store.path,
        title: opened.project.manifest.title || store.name,
        kind: store.kind,
      });
    } catch {
      /* the recent list is a convenience */
    }
  }
  return {
    url,
    networkUrls,
    port,
    server,
    close: async () => {
      clearInterval(heartbeat);
      unregister();
      await Promise.all([...others.values()].map((o) => o.close()));
      others.clear();
      store.off('change', onChange);
      store.stopWatching();
      for (const c of clients) c.end();
      clients.clear();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
    },
  };
}

/** IPv4 addresses of this computer's network interfaces (Wi-Fi, Tailscale…), as viewer links. */
function lanUrls(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a!.address}:${port}/`);
}
