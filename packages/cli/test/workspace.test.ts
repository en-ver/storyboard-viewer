import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  addAsset,
  addShot,
  diffProjectFiles,
  fileVersion,
  hasErrors,
  packSbd,
  serializeProject,
  setScript,
  type Asset,
  type SbdProject,
} from '@storyboard-viewer/format';
import { openProjectPath, readFolderTree } from '@storyboard-viewer/format/node';
import {
  startWorkspaceServer,
  type RunningServer,
  type WorkspaceListing,
  type WorkspaceSelection,
} from '../src/index.js';
import { readRecent, recordRecent } from '../src/recent.js';
import { findViewer } from '../src/registry.js';
import { ROOT } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).toReversed()) await fn();
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sbd-workspace-')));
  const projects = join(root, 'projects');
  const examples = join(root, 'examples');
  mkdirSync(projects);
  cpSync(join(ROOT, 'examples'), examples, { recursive: true });
  cpSync(join(ROOT, 'LICENSE'), join(root, 'LICENSE'));
  const previous = process.env['SBD_CONFIG_DIR'];
  process.env['SBD_CONFIG_DIR'] = join(root, 'config');
  cleanups.push(() => {
    if (previous === undefined) delete process.env['SBD_CONFIG_DIR'];
    else process.env['SBD_CONFIG_DIR'] = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const start = async (defaultProject?: string) => {
    const srv = await startWorkspaceServer({
      workspace: projects,
      examples,
      port: 0,
      watch: false,
      ...(defaultProject ? { defaultProject } : {}),
    });
    cleanups.push(() => srv.close());
    return srv;
  };
  return { root, projects, examples, start };
}
async function get<T>(srv: RunningServer, path: string): Promise<T> {
  const res = await fetch(new URL(path, srv.url));
  expect(res.status).toBe(200);
  return res.json() as Promise<T>;
}
async function post(
  srv: RunningServer,
  path: string,
  value: unknown,
  status = 200,
): Promise<WorkspaceSelection> {
  const res = await fetch(new URL(path, srv.url), {
    method: 'POST',
    headers: {
      'x-sbd-client': 'workspace-test',
      'content-type': 'application/json',
      origin: srv.url.replace(/\/$/, ''),
    },
    body: JSON.stringify(value),
  });
  expect(res.status).toBe(status);
  return res.json() as Promise<WorkspaceSelection>;
}
interface ProjectResponse {
  project: SbdProject;
  source: { readOnly: boolean; base: string; name: string };
  files: string[];
}

it('opens the read-only default with empty Projects and lists all six examples without seeding', async () => {
  const f = fixture();
  const srv = await f.start();
  const listing = await get<WorkspaceListing>(srv, '/api/workspace');
  expect(listing.projects).toEqual([]);
  expect(readdirSync(f.projects)).toEqual([]);
  expect(listing.examples).toHaveLength(6);
  expect(listing.presets).toContain('film');
  expect(listing.initial).toMatchObject({
    root: 'examples',
    name: 'midnight-snack.sbd',
    readOnly: true,
    warnings: [],
  });
  const initial = await get<ProjectResponse>(srv, `${listing.initial.url}api/project`);
  expect(initial.source).toMatchObject({
    readOnly: true,
    base: listing.initial.url,
    name: 'midnight-snack.sbd',
  });
  const fountain = await fetch(new URL(`${listing.initial.url}api/files/script.fountain`, srv.url));
  expect(await fountain.text()).toBe(
    readFileSync(join(f.examples, 'midnight-snack.sbd/script.fountain'), 'utf8'),
  );
  for (const entry of listing.examples) {
    const opened = await post(srv, '/api/workspace/open', {
      root: 'examples',
      name: entry.name,
    });
    expect(new URL(opened.url, srv.url).origin).toBe(new URL(srv.url).origin);
    const project = await get<ProjectResponse>(srv, `${opened.url}api/project`);
    expect(project.source.readOnly).toBe(true);
    const health = await get<{ name: string }>(srv, `${opened.url}api/health`);
    expect(health.name).toBe(entry.name);
  }
  expect((await get<ProjectResponse>(srv, `${listing.initial.url}api/project`)).project).toEqual(
    initial.project,
  );
});

it('creates, saves, uploads, links, exports, renames and reopens an owned unpacked Project on one listener', async () => {
  const f = fixture();
  const srv = await f.start();
  const selected = await post(
    srv,
    '/api/workspace/new',
    { name: 'Own.sbd', title: 'Own title', preset: 'film' },
    201,
  );
  expect(selected.readOnly).toBe(false);
  const before = await get<ProjectResponse>(srv, `${selected.url}api/project`);
  const scripted = setScript(before.project, 'Fixture action.').project;
  const shot = addShot(scripted, {
    id: 'fixture-shot',
    lines: scripted.ids.lines.map((l) => l.id),
  }).project;
  const next = {
    ...shot,
    manifest: { ...shot.manifest, title: 'Saved title', user_fixture: { keep: true } },
  };
  const changes = diffProjectFiles(before.project, next);
  const text = serializeProject(before.project);
  const events = new AbortController();
  const stream = await fetch(new URL(`${selected.url}api/events`, srv.url), {
    signal: events.signal,
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain('event: hello');
  const res = await fetch(new URL(`${selected.url}api/project`, srv.url), {
    method: 'PUT',
    headers: { 'x-sbd-client': 'workspace-test' },
    body: JSON.stringify({
      changes,
      base: Object.fromEntries(Object.keys(changes).map((key) => [key, fileVersion(text[key])])),
    }),
  });
  expect(res.status).toBe(200);
  expect(decoder.decode((await reader.read()).value)).toContain('event: change');
  events.abort();
  const image = readFileSync(join(f.examples, 'minimal.sbd/media/lamp.png'));
  const upload = await fetch(new URL(`${selected.url}api/media?name=lamp.png`, srv.url), {
    method: 'POST',
    headers: { 'x-sbd-client': 'workspace-test' },
    body: image,
  });
  expect(upload.status).toBe(200);
  const media = (await upload.json()) as { asset: { src: string }; created: string[] };
  expect(readFileSync(join(selected.path, media.asset.src))).toEqual(image);
  const ranged = await fetch(new URL(`${selected.url}api/files/${media.asset.src}`, srv.url), {
    headers: { range: 'bytes=0-9' },
  });
  expect(Buffer.from(await ranged.arrayBuffer())).toEqual(image.subarray(0, 10));
  const linked = await fetch(new URL(`${selected.url}api/link`, srv.url), {
    method: 'POST',
    headers: { 'x-sbd-client': 'workspace-test' },
    body: JSON.stringify({ path: join(selected.path, media.asset.src) }),
  });
  expect(linked.status).toBe(200);
  const linkResult = (await linked.json()) as { asset: Asset };
  const linkedBefore = await get<ProjectResponse>(srv, `${selected.url}api/project`);
  const savedLink = addAsset(linkedBefore.project, {
    ...linkResult.asset,
    id: 'saved-link',
    poster: `file:Own.sbd/media/../${media.asset.src}`,
    variants: [
      {
        src: `file:${join(selected.path, media.asset.src)}`,
        label: 'Original',
        user_fixture: 17,
      },
    ],
    user_fixture: { rights: 'retained' },
  }).project;
  const linkChanges = diffProjectFiles(linkedBefore.project, savedLink);
  const linkText = serializeProject(linkedBefore.project);
  const linkSave = await fetch(new URL(`${selected.url}api/project`, srv.url), {
    method: 'PUT',
    headers: { 'x-sbd-client': 'workspace-test' },
    body: JSON.stringify({
      changes: linkChanges,
      base: Object.fromEntries(
        Object.keys(linkChanges).map((key) => [key, fileVersion(linkText[key])]),
      ),
    }),
  });
  expect(linkSave.status).toBe(200);
  const saved = await get<ProjectResponse>(srv, `${selected.url}api/project`);
  expect(saved.project.assets.assets).toHaveLength(1);
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const imageHash = hash(image);
  const download = await fetch(new URL(`${selected.url}api/download`, srv.url));
  expect(download.status).toBe(200);
  expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(image.length);
  const thumb = await fetch(new URL(`${selected.url}api/recent/thumbnail`, srv.url), {
    method: 'PUT',
    headers: { 'x-sbd-client': 'workspace-test' },
    body: JSON.stringify({ thumbnail: 'data:image/png;base64,AAAA' }),
  });
  expect(thumb.status).toBe(200);
  const renamed = await post(srv, '/api/workspace/rename', {
    token: selected.token,
    name: 'Renamed.sbd',
    externalWritersPaused: true,
  });
  expect(renamed.token).not.toBe(selected.token);
  expect(renamed.title).toBe('Saved title');
  expect(await findViewer(renamed.path)).toBe(new URL(renamed.url, srv.url).href);
  expect(readFileSync(join(renamed.path, media.asset.src))).toEqual(image);
  expect(hash(readFileSync(join(renamed.path, media.asset.src)))).toBe(imageHash);
  const fresh = await get<ProjectResponse>(srv, `${renamed.url}api/project`);
  const renamedSrc = `file:Renamed.sbd/${media.asset.src}`;
  expect(fresh.project).toEqual({
    ...saved.project,
    assets: {
      ...saved.project.assets,
      assets: saved.project.assets.assets.map((asset) => ({
        ...asset,
        src: renamedSrc,
        poster: renamedSrc,
        variants: asset.variants!.map((variant) => ({ ...variant, src: renamedSrc })),
      })),
    },
  });
  expect(fresh.project.ids).toEqual(saved.project.ids);
  expect(fresh.project.ids.lines.length).toBeGreaterThan(0);
  expect(fresh.project.ids.shots[0]?.id).toBe('fixture-shot');
  for (const src of [
    fresh.project.assets.assets[0]!.src,
    fresh.project.assets.assets[0]!.poster!,
    fresh.project.assets.assets[0]!.variants![0]!.src,
  ]) {
    const response = await fetch(
      new URL(`${renamed.url}api/linked?src=${encodeURIComponent(src)}`, srv.url),
    );
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(image);
    expect(hash(bytes)).toBe(imageHash);
  }
  const reopened = await post(srv, '/api/workspace/open', {
    root: 'projects',
    name: renamed.name,
  });
  expect(reopened.token).toBe(renamed.token);
  expect((await get<ProjectResponse>(srv, `${reopened.url}api/project`)).project).toEqual(
    fresh.project,
  );
  const persisted = readRecent().find((e) => e.path === renamed.path);
  expect(persisted?.thumbnail).toBe('data:image/png;base64,AAAA');
  expect(readRecent().some((e) => e.path === selected.path)).toBe(false);
  // A new user-created project can reuse a basename, but receives a new lifetime identity.
  const reused = await post(srv, '/api/workspace/new', { name: 'Own.sbd' }, 201);
  expect(reused.token).not.toBe(selected.token);
  expect((await get<ProjectResponse>(srv, `${renamed.url}api/project`)).source.name).toBe(
    'Renamed.sbd',
  );

  // Sequential external replacement of an owned project, then explicit Open on the same listener.
  const initialServer = await f.start('Renamed.sbd');
  const oldInitial = (await get<WorkspaceListing>(initialServer, '/api/workspace')).initial;
  renameSync(renamed.path, join(f.root, 'retained-before-replacement.sbd'));
  cpSync(join(f.examples, 'minimal.sbd'), renamed.path, { recursive: true });
  const expected = await openProjectPath(renamed.path);
  expect(hasErrors(expected.issues)).toBe(false);
  await expected.close();
  // Shell and hashed app resources must not depend on the initial project's inode or token.
  const shell = await fetch(initialServer.url);
  expect(shell.status).toBe(200);
  const html = await shell.text();
  expect(html).toContain('name="sbd-workspace"');
  const scriptPath = /src="([^"]+\.js)"/.exec(html)![1]!;
  expect((await fetch(new URL(scriptPath, initialServer.url))).status).toBe(200);
  const replacement = await post(initialServer, '/api/workspace/open', {
    root: 'projects',
    name: 'Renamed.sbd',
  });
  expect(replacement.token).not.toBe(oldInitial.token);
  const replacementResponse = await get<ProjectResponse>(
    initialServer,
    `${replacement.url}api/project`,
  );
  expect(replacementResponse.project).toEqual(expected.project);
  expect(replacementResponse.project.ids).toEqual(expected.project.ids);
  expect(replacementResponse.project.assets).toEqual(expected.project.assets);
  expect((await get<WorkspaceListing>(initialServer, '/api/workspace')).initial).toEqual(
    replacement,
  );
  expect(await findViewer(replacement.path)).toBe(new URL(replacement.url, initialServer.url).href);
  expect(readRecent().find((e) => e.path === replacement.path)?.title).toBe(
    expected.project.manifest.title,
  );
  const refreshedShell = await fetch(initialServer.url);
  expect(await refreshedShell.text()).toContain(`name="sbd-base" content="${replacement.url}"`);
});

it('copies only the selected immutable example with original bytes and writable ownership, and applies restart precedence', async () => {
  const f = fixture();
  const src = join(f.examples, 'minimal.sbd');
  const original = await readFolderTree(src);
  for (const path of Object.keys(original)) chmodSync(join(src, path), 0o444);
  const unrelated = {
    path: join(f.root, 'other.sbd'),
    title: 'Unrelated',
    kind: 'folder' as const,
    openedAt: 1,
  };
  recordRecent(unrelated);
  const srv = await f.start();
  const copy = await post(
    srv,
    '/api/workspace/copy',
    { example: 'minimal.sbd', name: 'Copy.sbd' },
    201,
  );
  const copied = await readFolderTree(copy.path);
  for (const [path, bytes] of Object.entries(original)) {
    expect(copied[path]).toEqual(bytes);
    expect(statSync(join(copy.path, path)).mode & 0o200).toBe(0o200);
    expect(statSync(join(copy.path, path)).uid).toBe(statSync(f.projects).uid);
  }
  expect(copied['LICENSE']).toEqual(new Uint8Array(readFileSync(join(f.root, 'LICENSE'))));
  expect(copied['EXAMPLES-README.md']).toEqual(
    new Uint8Array(readFileSync(join(f.examples, 'README.md'))),
  );
  expect(Buffer.from(copied['SOURCE.md']!).toString()).toContain(
    '9f1f6025d9307ae5ca63654f895a69cb0f04c9ac',
  );
  const source = await post(srv, '/api/workspace/open', {
    root: 'examples',
    name: 'minimal.sbd',
  });
  expect((await get<ProjectResponse>(srv, `${copy.url}api/project`)).project).toEqual(
    (await get<ProjectResponse>(srv, `${source.url}api/project`)).project,
  );
  const other = await post(
    srv,
    '/api/workspace/new',
    { name: 'Other.sbd', preset: 'vertical' },
    201,
  );
  const restarted = await f.start();
  expect((await get<WorkspaceListing>(restarted, '/api/workspace')).initial.path).toBe(other.path);
  const explicit = await f.start('Copy.sbd');
  expect((await get<WorkspaceListing>(explicit, '/api/workspace')).initial.path).toBe(copy.path);
  expect(readRecent().find((e) => e.path === unrelated.path)).toEqual(unrelated);
  writeFileSync(join(f.projects, 'Packed.sbd'), packSbd(original));
  const packed = await post(srv, '/api/workspace/open', {
    root: 'projects',
    name: 'Packed.sbd',
  });
  expect(packed).toMatchObject({ kind: 'packed', readOnly: true });
  expect((await get<ProjectResponse>(srv, `${packed.url}api/project`)).project).toEqual(
    (await get<ProjectResponse>(srv, `${source.url}api/project`)).project,
  );
});
