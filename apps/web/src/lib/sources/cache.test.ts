import { describe, expect, it, vi } from 'vitest';
import { mergeRecents, openShared, sharedToEntry, timeAgo, type RecentEntry } from './cache';

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

  it('says how long ago', () => {
    expect(timeAgo(0, 30_000)).toBe('just now');
    expect(timeAgo(0, 5 * 60_000)).toBe('5 min ago');
  });
});
