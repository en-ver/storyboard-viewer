import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAsset,
  diffProjectFiles,
  fileVersion,
  packSbd,
  serializeProject,
  updateShot,
} from '@storyboard-viewer/format';
import { openProjectPath, readFolderTree, zipFileReader } from '@storyboard-viewer/format/node';
import { ProjectStore, startServer, type RunningServer } from '../src/index.js';
import {
  configDir,
  isThumbnail,
  MAX_SHARED_RECENT,
  MAX_THUMBNAIL,
  readRecent,
  recordRecent,
  setRecentThumbnail,
} from '../src/recent.js';
import { exampleCopy, getJson } from './helpers.js';

const cleanups: Array<() => unknown> = [];
// oxlint-disable-next-line typescript/no-explicit-any
const json = (r: Response): Promise<any> => r.json();
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

async function serve(
  path: string,
  webRoot: string | null = null,
): Promise<{ srv: RunningServer; store: ProjectStore; base: string }> {
  const store = ProjectStore.open(path);
  const srv = await startServer(store, { port: 0, webRoot });
  cleanups.push(() => srv.close());
  return { srv, store, base: srv.url.replace(/\/$/, '') };
}

/** Minimal SSE reader: resolves with the first event of `type`. */
async function nextEvent(
  base: string,
  type: string,
  trigger: () => unknown,
  timeoutMs = 4000,
): Promise<{ revision: number; files: string[] }> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let triggered = false;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev === 'hello' && !triggered) {
          triggered = true;
          await trigger();
        }
        if (ev === type && data) return JSON.parse(data);
      }
    }
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

describe('sbd serve', () => {
  it('serves health and the project JSON', async () => {
    const ex = exampleCopy();
    cleanups.push(ex.cleanup);
    const { base } = await serve(ex.dir);
    const health = await getJson(`${base}/api/health`);
    expect(health).toMatchObject({ ok: true, app: 'sbd', kind: 'folder' });
    const body = await getJson(`${base}/api/project`);
    expect(body.project.ids.shots.map((s: { id: string }) => s.id)).toEqual([
      'opening',
      'climb',
      'match',
      'lamp',
    ]);
    expect(body.source).toMatchObject({ kind: 'folder', readOnly: false, name: 'story.sbd' });
    expect(body.media['media/dialogue.wav'].size).toBe(224044);
    expect(body.issues.filter((i: { severity: string }) => i.severity === 'error')).toEqual([]);
  });

  it('lists network links only when listening on all interfaces', async () => {
    const ex = exampleCopy();
    cleanups.push(ex.cleanup);
    const { srv } = await serve(ex.dir);
    expect(srv.networkUrls).toEqual([]);
    const lan = await startServer(ProjectStore.open(ex.dir), {
      port: 0,
      host: '0.0.0.0',
      webRoot: null,
      register: false,
    });
    cleanups.push(() => lan.close());
    expect(lan.url).toBe(`http://localhost:${lan.port}/`);
    for (const u of lan.networkUrls) expect(u).toMatch(new RegExp(`^http://[\\d.]+:${lan.port}/$`));
  });

  it('serves media with HTTP Range support', async () => {
    const ex = exampleCopy();
    cleanups.push(ex.cleanup);
    const { base } = await serve(ex.dir);
    const full = await fetch(`${base}/api/files/media/dialogue.wav`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-type')).toBe('audio/wav');
    const bytes = new Uint8Array(await full.arrayBuffer());
    expect(bytes.length).toBe(224044);
    const part = await fetch(`${base}/api/files/media/dialogue.wav`, {
      headers: { range: 'bytes=100-199' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/224044');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(100, 200));
    const tail = await fetch(`${base}/api/files/media/dialogue.wav`, {
      headers: { range: 'bytes=-10' },
    });
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(-10));
    const bad = await fetch(`${base}/api/files/media/dialogue.wav`, {
      headers: { range: 'bytes=999999-' },
    });
    expect(bad.status).toBe(416);
    expect((await fetch(`${base}/api/files/..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
    expect((await fetch(`${base}/api/files/media/nope.png`)).status).toBe(404);
  });

  it('serves linked file: media only when referenced', async () => {
    const ex = exampleCopy();
    cleanups.push(ex.cleanup);
    mkdirSync(join(ex.work, 'renders'));
    writeFileSync(
      join(ex.work, 'renders/clip.mp4'),
      readFileSync(join(ex.dir, 'media/lamp-sweep.mp4')),
    );
    writeFileSync(join(ex.work, 'secret.txt'), 'nope');
    const { store, base } = await serve(ex.dir);
    await store.edit((p) =>
      addAsset(p, { id: 'linked', name: 'Linked', kind: 'video', src: 'file:renders/clip.mp4' }),
    );
    const res = await fetch(
      `${base}/api/linked?src=${encodeURIComponent('file:renders/clip.mp4')}`,
      { headers: { range: 'bytes=0-9' } },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const denied = await fetch(`${base}/api/linked?src=${encodeURIComponent('file:secret.txt')}`);
    expect(denied.status).toBe(403);
  });

  it('pushes SSE change events for edits and for external file changes', async () => {
    const ex = exampleCopy();
    cleanups.push(ex.cleanup);
    const { store, base } = await serve(ex.dir);
    const fromEdit = await nextEvent(base, 'change', () =>
      store.edit((p) => ({ project: updateShot(p, 'opening', { title: 'Edited' }) })),
    );
    expect(fromEdit.files).toContain('shots/opening.json');
    const fromDisk = await nextEvent(base, 'change', () => {
      const f = join(ex.dir, 'script.fountain');
      writeFileSync(f, readFileSync(f, 'utf8').replace('black rocks', 'jagged rocks'));
    });
    expect(fromDisk.files.join()).toMatch(/script\.fountain/);
    expect(fromDisk.revision).toBeGreaterThan(fromEdit.revision);
    const body = await getJson(`${base}/api/project`);
    expect(body.project.script).toContain('jagged rocks');
    expect(body.reanchor).not.toBeNull();
  });

  it('serves a packed .sbd (slicing STOREd media) and saves edits in place', async () => {
    const ex = exampleCopy();
    cleanups.push(ex.cleanup);
    const file = join(ex.work, 'packed.sbd');
    writeFileSync(file, packSbd(await readFolderTree(ex.dir)));
    const original = readFileSync(file);
    const { store, base } = await serve(file);
    expect(store.readOnly).toBe(false);
    const body = await getJson(`${base}/api/project`);
    expect(body.source).toMatchObject({ kind: 'packed', readOnly: false });
    const wav = readFileSync(join(ex.dir, 'media/music.wav'));
    const part = await fetch(`${base}/api/files/media/music.wav`, {
      headers: { range: 'bytes=1000-1099' },
    });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(wav.subarray(1000, 1100));
    const json = await getJson(`${base}/api/files/manifest.json`);
    expect(json.title).toBe("The Keeper's Light");
    const dl = await fetch(`${base}/api/download`);
    expect(Buffer.from(await dl.arrayBuffer()).equals(original)).toBe(true);

    // an edit re-packs the file in place; the previous version is kept as .bak
    const r = await store.edit((p) => ({ project: updateShot(p, 'climb', { title: 'Packed!' }) }));
    expect(r.written).toEqual(expect.arrayContaining(['shots/climb.json', 'manifest.json']));
    expect(readFileSync(`${file}.bak`).equals(original)).toBe(true);
    const after = readFileSync(file);
    expect(after.subarray(30, 38).toString()).toBe('mimetype');
    const reopened = await openProjectPath(file);
    await reopened.close();
    expect(reopened.project.shots['climb']!.title).toBe('Packed!');
    expect(reopened.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // media are still STOREd (sliceable) and unchanged
    const zr = await zipFileReader(file);
    expect(zr.entry('media/music.wav')!.method).toBe(0);
    expect(Buffer.from((await zr.read('media/music.wav'))!).equals(wav)).toBe(true);
    await zr.close();
    // media URLs are versioned by content, so a save does not reload every picture
    const again = await getJson(`${base}/api/project`);
    expect(again.media['media/music.wav'].mtime).toBe(body.media['media/music.wav'].mtime);
    // the .bak keeps the version from before this session's first save
    await store.edit((p) => ({ project: updateShot(p, 'climb', { title: 'Twice' }) }));
    expect(readFileSync(`${file}.bak`).equals(original)).toBe(true);
    // no temp files left behind
    expect(readdirSync(ex.work).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('serves the web app with SPA fallback', async () => {
    const ex = exampleCopy();
    cleanups.push(ex.cleanup);
    const web = join(ex.work, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><head><title>app</title></head>');
    writeFileSync(join(web, 'assets/app.js'), 'console.log(1)');
    const { base } = await serve(ex.dir, web);
    const index = await fetch(`${base}/`);
    const html = await index.text();
    expect(html).toContain('<title>app</title>');
    expect(html).toContain('<meta name="sbd-serve"');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toContain('immutable');
    // the shell is never cached without asking: a rebuilt app reaches the browser
    writeFileSync(join(web, 'sw.js'), 'self.x = 1');
    writeFileSync(join(web, 'manifest.webmanifest'), '{}');
    for (const path of ['/index.html', '/sw.js', '/manifest.webmanifest', '/story/shot/1'])
      expect([path, (await fetch(`${base}${path}`)).headers.get('cache-control')]).toEqual([
        path,
        'no-cache',
      ]);
    expect(await (await fetch(`${base}/story/shot/1`)).text()).toContain('<title>app</title>');
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  describe('writes from the web app', () => {
    const headers = { 'content-type': 'application/json', 'x-sbd-client': 'test-client' };

    async function put(base: string, before: unknown, after: unknown, extra = {}) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const b = before as any;
      // oxlint-disable-next-line typescript/no-explicit-any
      const changes = diffProjectFiles(b, after as any);
      const files = serializeProject(b);
      const baseVersions = Object.fromEntries(
        Object.keys(changes).map((k) => [k, fileVersion(files[k])]),
      );
      return fetch(`${base}/api/project`, {
        method: 'PUT',
        headers: { ...headers, ...extra },
        body: JSON.stringify({ changes, base: baseVersions }),
      });
    }

    it('saves changed files, tags the SSE event with the client and detects conflicts', async () => {
      const ex = exampleCopy();
      cleanups.push(ex.cleanup);
      const { store, base } = await serve(ex.dir);
      const loaded = (await getJson(`${base}/api/project`)).project;
      const edited = updateShot(loaded, 'climb', { title: 'From the app' });
      let res!: Response;
      const ev = await nextEvent(base, 'change', async () => {
        res = await put(base, loaded, edited);
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.written).toEqual(expect.arrayContaining(['shots/climb.json']));
      expect(body.project.shots.climb.title).toBe('From the app');
      expect((ev as unknown as { origin: string }).origin).toBe('test-client');
      const disk = JSON.parse(readFileSync(join(ex.dir, 'shots/climb.json'), 'utf8'));
      expect(disk.title).toBe('From the app');

      // An agent edits the same file: a save based on the old state is refused...
      await store.edit((p) => ({ project: updateShot(p, 'climb', { title: 'Agent' }) }));
      const stale = updateShot(loaded, 'climb', { title: 'Stale' });
      const conflict = await put(base, loaded, stale);
      expect(conflict.status).toBe(409);
      expect((await json(conflict)).conflicts).toEqual(['shots/climb.json']);
      // ...while a save touching other files goes through.
      const other = await put(base, loaded, updateShot(loaded, 'lamp', { title: 'Lamp!' }));
      expect(other.status).toBe(200);
      expect(JSON.parse(readFileSync(join(ex.dir, 'shots/climb.json'), 'utf8')).title).toBe(
        'Agent',
      );
    });

    it('refuses invalid edits, foreign origins and missing client headers', async () => {
      const ex = exampleCopy();
      cleanups.push(ex.cleanup);
      const { base } = await serve(ex.dir);
      const loaded = (await getJson(`${base}/api/project`)).project;
      const broken = structuredClone(loaded);
      broken.shots.climb.active_variant = 'nope';
      const bad = await put(base, loaded, broken);
      expect(bad.status).toBe(422);
      expect((await json(bad)).error).toMatch(/invalid/);
      const csrf = await put(base, loaded, updateShot(loaded, 'climb', { title: 'x' }), {
        origin: 'https://evil.example',
      });
      expect(csrf.status).toBe(403);
      const noHeader = await fetch(`${base}/api/project`, { method: 'PUT', body: '{}' });
      expect(noHeader.status).toBe(403);
      const path = await fetch(`${base}/api/project`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ changes: { 'media/x.png': 'x' } }),
      });
      expect(path.status).toBe(400);
    });

    it('uploads media into media/ and prepares linked assets', async () => {
      const ex = exampleCopy();
      cleanups.push(ex.cleanup);
      const { base } = await serve(ex.dir);
      const png = readFileSync(join(ex.dir, 'media/maya.png'));
      const up = await fetch(`${base}/api/media?name=${encodeURIComponent('Hero Shot.png')}`, {
        method: 'POST',
        headers: { 'x-sbd-client': 'c' },
        body: png,
      });
      expect(up.status).toBe(200);
      const { asset, created } = await json(up);
      expect(created).toEqual(['media/hero-shot.png']);
      expect(asset).toMatchObject({ kind: 'image', src: 'media/hero-shot.png', name: 'Hero Shot' });
      expect(asset.width).toBeGreaterThan(0);
      expect(readFileSync(join(ex.dir, 'media/hero-shot.png'))).toEqual(png);

      mkdirSync(join(ex.work, 'renders'));
      writeFileSync(
        join(ex.work, 'renders/take.wav'),
        readFileSync(join(ex.dir, 'media/music.wav')),
      );
      const link = await fetch(`${base}/api/link`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'renders/take.wav' }),
      });
      expect(link.status).toBe(200);
      expect((await json(link)).asset).toMatchObject({
        kind: 'audio',
        src: 'file:renders/take.wav',
      });
      const missing = await fetch(`${base}/api/link`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'renders/nope.wav' }),
      });
      expect(missing.status).toBe(404);
    });

    it('saves app edits and media uploads into a packed .sbd', async () => {
      const ex = exampleCopy();
      cleanups.push(ex.cleanup);
      const file = join(ex.work, 'packed.sbd');
      writeFileSync(file, packSbd(await readFolderTree(ex.dir)));
      const { base } = await serve(file);
      const loaded = (await getJson(`${base}/api/project`)).project;
      const res = await put(base, loaded, updateShot(loaded, 'climb', { title: 'From the app' }));
      expect(res.status).toBe(200);
      expect((await json(res)).project.shots.climb.title).toBe('From the app');
      const png = readFileSync(join(ex.dir, 'media/maya.png'));
      const up = await fetch(`${base}/api/media?name=${encodeURIComponent('New Pic.png')}`, {
        method: 'POST',
        headers: { 'x-sbd-client': 'test-client' },
        body: png,
      });
      expect(up.status).toBe(200);
      const { asset } = await json(up);
      expect(asset.src).toBe('media/new-pic.png');
      const zr = await zipFileReader(file);
      expect(zr.entry('media/new-pic.png')!.method).toBe(0);
      await zr.close();
      const served = await fetch(`${base}/api/files/media/new-pic.png`);
      expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
      const reopened = await openProjectPath(file);
      await reopened.close();
      expect(reopened.project.shots['climb']!.title).toBe('From the app');
    });
  });
});

describe('shared recent storyboards', () => {
  const headers = { 'content-type': 'application/json', 'x-sbd-client': 'test-client' };
  let dir = '';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['SBD_CONFIG_DIR'];
    dir = mkdtempSync(join(tmpdir(), 'sbd-config-'));
    process.env['SBD_CONFIG_DIR'] = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['SBD_CONFIG_DIR'];
    else process.env['SBD_CONFIG_DIR'] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('config dir: SBD_CONFIG_DIR, XDG_CONFIG_HOME, then ~/.config', () => {
    expect(configDir({ SBD_CONFIG_DIR: '/x' })).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/y' })).toBe(join('/y', 'storyboard-viewer'));
    expect(configDir({ HOME: '/h' })).toMatch(/storyboard-viewer$/);
  });

  it('records, de-duplicates, caps and removes entries', () => {
    for (let i = 0; i < 12; i++)
      recordRecent({ path: `/p/${i % 11}`, title: `T${i}`, kind: 'folder', openedAt: 1000 + i });
    const list = readRecent();
    expect(list).toHaveLength(MAX_SHARED_RECENT);
    expect(list[0]).toMatchObject({ path: '/p/0', title: 'T11' }); // re-recorded, now newest
    expect(new Set(list.map((e) => e.path)).size).toBe(list.length);
    expect(setRecentThumbnail('/p/0', 'data:image/webp;base64,AAAA')).toBe(true);
    recordRecent({ path: '/p/0', title: 'T12', kind: 'folder' });
    expect(readRecent()[0]!.thumbnail).toBe('data:image/webp;base64,AAAA'); // kept
    expect(isThumbnail('data:image/webp;base64,AAAA')).toBe(true);
    expect(isThumbnail('javascript:alert(1)')).toBe(false);
    expect(isThumbnail(`data:image/png;base64,${'A'.repeat(MAX_THUMBNAIL)}`)).toBe(false);
    writeFileSync(join(dir, 'recent.json'), 'not json');
    expect(readRecent()).toEqual([]); // a broken file is an empty list
  });

  it('serve records its storyboard; /api/recent lists, opens and forgets across servers', async () => {
    const a = exampleCopy('a.sbd');
    const b = exampleCopy('b.sbd');
    cleanups.push(a.cleanup, b.cleanup);
    const srvA = await startServer(ProjectStore.open(a.dir), {
      port: 0,
      webRoot: null,
      recent: true,
    });
    await srvA.close();
    const srvB = await startServer(ProjectStore.open(b.dir), {
      port: 0,
      webRoot: null,
      recent: true,
    });
    cleanups.push(() => srvB.close());
    const base = srvB.url.replace(/\/$/, '');
    const list = await getJson(`${base}/api/recent`);
    expect(list.current).toBe(b.dir);
    expect(list.file).toBe(join(dir, 'recent.json'));
    expect(list.recent.map((e: { path: string }) => e.path)).toEqual([b.dir, a.dir]);
    expect(list.recent[0]).toMatchObject({ title: "The Keeper's Light", kind: 'folder' });

    // thumbnail for this server's storyboard (validated)
    const put = (thumbnail: string) =>
      fetch(`${base}/api/recent/thumbnail`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ thumbnail }),
      });
    expect((await put('data:text/html;base64,AAAA')).status).toBe(400);
    expect(await json(await put('data:image/webp;base64,AAAA'))).toEqual({ ok: true });
    expect(readRecent()[0]!.thumbnail).toBe('data:image/webp;base64,AAAA');

    // writes need the app's header and the same origin
    const open = (path: string, h: Record<string, string> = headers) =>
      fetch(`${base}/api/open`, { method: 'POST', headers: h, body: JSON.stringify({ path }) });
    expect((await open(a.dir, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await open(a.dir, { ...headers, origin: 'http://evil.example' })).status).toBe(403);
    // only paths from the list
    expect((await open('/etc')).status).toBe(403);
    // this server's own storyboard: its own URL
    expect(await json(await open(b.dir))).toEqual({ url: srvB.url });
    // A is not running: a new server in this process
    const opened = await json(await open(a.dir));
    expect(opened.url).not.toBe(srvB.url);
    const health = await getJson(`${opened.url}api/health`);
    expect(health).toMatchObject({ app: 'sbd', path: a.dir });
    // asked again: the same server
    expect(await json(await open(a.dir))).toEqual(opened);

    // remove one, then clear
    const del = (q = '') => fetch(`${base}/api/recent${q}`, { method: 'DELETE', headers });
    expect((await fetch(`${base}/api/recent`, { method: 'DELETE' })).status).toBe(403);
    await del(`?path=${encodeURIComponent(b.dir)}`);
    expect(readRecent().map((e) => e.path)).toEqual([a.dir]);
    await del();
    expect((await getJson(`${base}/api/recent`)).recent).toEqual([]);
    // closing B closes the server it started for A
    await srvB.close();
    await expect(fetch(`${opened.url}api/health`)).rejects.toThrow('fetch failed');
  });

  it('servers without the recent option leave the list alone', async () => {
    const ex = exampleCopy();
    cleanups.push(ex.cleanup);
    const { base } = await serve(ex.dir);
    expect((await getJson(`${base}/api/recent`)).recent).toEqual([]);
    const put = await fetch(`${base}/api/recent/thumbnail`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ thumbnail: 'data:image/webp;base64,AAAA' }),
    });
    expect(await json(put)).toEqual({ ok: false });
    await fetch(`${base}/api/recent?path=x`, { method: 'DELETE', headers });
    expect(existsSync(join(dir, 'recent.json'))).toBe(false); // nothing written
  });
});
