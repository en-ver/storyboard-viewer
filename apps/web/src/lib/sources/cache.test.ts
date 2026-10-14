import { createProject } from '@storyboard-viewer/format';
import { describe, expect, it, vi } from 'vitest';
import { detectServer, serverHealth, serverSource } from './server';
import {
  fetchSharedRecent,
  mergeRecents,
  openShared,
  sharedToEntry,
  timeAgo,
  type RecentEntry,
} from './cache';

const local = (id: string, openedAt: number, path?: string): RecentEntry => ({
  id,
  kind: id.startsWith('server:') ? 'server' : 'zip',
  title: id,
  name: id,
  location: '',
  openedAt,
  ...(path ? { path } : {}),
});

describe('recent storyboards', () => {
  it('turns a shared entry into a start-screen entry', () => {
    const e = sharedToEntry({
      path: '/Users/me/Story/cat.sbd',
      title: 'Cat',
      kind: 'folder',
      openedAt: 5,
      thumbnail: 'data:image/webp;base64,AA',
    });
    expect(e).toMatchObject({
      id: 'served:/Users/me/Story/cat.sbd',
      kind: 'served',
      name: 'cat.sbd',
      location: 'Folder · cat.sbd',
      thumbUrl: 'data:image/webp;base64,AA',
    });
    expect(
      sharedToEntry({ path: 'C:\\s\\x.sbd', title: '', kind: 'packed', openedAt: 1 }),
    ).toMatchObject({ title: 'x.sbd', location: '.sbd file · x.sbd' });
  });

  it('merges shared and browser entries: newest first, one per path, at most five', () => {
    const merged = mergeRecents(
      [
        local('server:http://localhost:4401/', 900, '/a.sbd'), // same storyboard as shared /a
        local('zip:drop.sbd', 800),
        local('server:http://localhost:4409/', 50, '/z.sbd'), // only this browser knows it
      ],
      [
        { path: '/a.sbd', title: 'A', kind: 'folder', openedAt: 100 },
        { path: '/b.sbd', title: 'B', kind: 'folder', openedAt: 700 },
        { path: '/c.sbd', title: 'C', kind: 'packed', openedAt: 600 },
        { path: '/d.sbd', title: 'D', kind: 'folder', openedAt: 500 },
      ],
    );
    expect(merged.map((e) => e.id)).toEqual([
      'served:/a.sbd', // opened in this browser at 900
      'zip:drop.sbd',
      'served:/b.sbd',
      'served:/c.sbd',
      'served:/d.sbd',
    ]);
    expect(merged[0]!.openedAt).toBe(900);
    expect(mergeRecents([local('zip:x', 1)], [])).toHaveLength(1);
  });

  it('reopens the current storyboard at the requesting origin, including an explicit base', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ url: 'http://viewer:4400/', current: true })),
      );
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await openShared('browser', '/storyboard.sbd')).toBe('/');
      expect(await openShared('browser', '/storyboard.sbd', 'http://localhost:4401/proxy')).toBe(
        'http://localhost:4401/',
      );
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/open',
        'http://localhost:4401/proxy/api/open',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the advertised URL for another storyboard', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ url: 'http://localhost:4402/' }))),
    );
    try {
      expect(await openShared('browser', '/other.sbd')).toBe('http://localhost:4402/');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the scoped workspace URL and reports history warnings', async () => {
    const warning = 'Shared history was not persisted/read.';
    const report = vi.fn<(warnings: string[]) => void>();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ url: '/p/token/', current: true, recent: [], warnings: [warning] }),
            ),
        ),
    );
    try {
      expect(await openShared('browser', '/projects/test.sbd', '', report)).toBe('/p/token/');
      expect(await fetchSharedRecent('', report)).toEqual([]);
      expect(report).toHaveBeenCalledWith([warning]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('loads a read-only example with scoped media and no mutation callbacks', async () => {
    const base = `/p/${'a'.repeat(48)}`;
    const source = serverSource(base, 'example.sbd', '/examples/example.sbd', true, {
      root: 'examples',
      label: 'Examples',
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          project: createProject({ title: 'Test data', preset: 'blank' }),
          issues: [],
          files: ['media/test.png'],
          media: { 'media/test.png': { size: 1, mtime: 2 } },
          source: { readOnly: true },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      const loaded = await source.load();
      expect(fetch).toHaveBeenCalledWith(`${base}/api/project`, { cache: 'no-store' });
      expect(loaded.media.url('media/test.png')).toBe(`${base}/api/files/media/test.png?v=2`);
      expect(source.saveMode).toBe('none');
      expect(source.save).toBeUndefined();
      expect(source.uploadMedia).toBeUndefined();
      expect(source.linkPath).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads live listener mode and an explicit scoped selection without shell metadata', async () => {
    const base = `/p/${'c'.repeat(48)}`;
    const project = createProject({ title: 'Test data', preset: 'blank' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = String(url);
      const body =
        path === '/api/health'
          ? { app: 'sbd', mode: 'workspace', initial: { url: `/p/${'d'.repeat(48)}/` } }
          : path === `${base}/api/health`
            ? { app: 'sbd', name: 'selected.sbd', readOnly: true }
            : {
                project,
                source: {
                  name: 'selected.sbd',
                  path: '/examples/selected.sbd',
                  readOnly: true,
                  workspace: { root: 'examples', label: 'Examples' },
                },
              };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    // A cached legacy shell cannot supply mode or the selected token.
    vi.stubGlobal('document', { querySelector: () => null });
    try {
      expect((await serverHealth())?.mode).toBe('workspace');
      const source = await detectServer(base);
      expect(source).toMatchObject({
        url: base,
        name: 'selected.sbd',
        readOnly: true,
        workspace: { root: 'examples', label: 'Examples' },
      });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/health',
        `${base}/api/health`,
        `${base}/api/project`,
      ]);
      // Legacy health has no mode. Stale workspace/base markers must not change it.
      fetch.mockReset();
      fetch.mockImplementation(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url) === '/api/health'
                ? { app: 'sbd', name: 'legacy.sbd', readOnly: false }
                : {
                    project,
                    source: { name: 'legacy.sbd', path: '/legacy.sbd', readOnly: false },
                  },
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
      );
      vi.stubGlobal('document', { querySelector: () => ({ content: base }) });
      expect((await serverHealth())?.mode).toBeUndefined();
      expect(await detectServer()).toMatchObject({ url: '', name: 'legacy.sbd', readOnly: false });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/health',
        '/api/health',
        '/api/project',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uploads into the selected writable project route', async () => {
    const base = `/p/${'b'.repeat(48)}`;
    const source = serverSource(base, 'test.sbd', '/projects/test.sbd', false);
    const asset = { name: 'Test data', kind: 'image', src: 'media/test.png' };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ asset })));
    vi.stubGlobal('fetch', fetch);
    try {
      const file = new File(['Test data'], 'test.png', { type: 'image/png' });
      expect(await source.uploadMedia!(file, 'browser')).toEqual(asset);
      expect(fetch).toHaveBeenCalledWith(`${base}/api/media?name=test.png`, {
        method: 'POST',
        body: file,
        headers: { 'x-sbd-client': 'browser' },
      });
      expect(source.saveMode).toBe('server');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says how long ago', () => {
    expect(timeAgo(0, 30_000)).toBe('just now');
    expect(timeAgo(0, 5 * 60_000)).toBe('5 min ago');
  });
});
