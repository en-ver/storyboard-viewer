import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkPackage,
  dependencyGraph,
  installedGraph,
  metadataManifest,
} from '../check-image-package.mjs';

function put(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof data === 'object' ? JSON.stringify(data) : data);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sbd-image-package-'));
  t.after(() => rmSync(root, { recursive: true }));
  const source = join(root, 'source');
  const deployed = join(root, 'deployed');
  const cli = join(source, 'packages/cli');
  const format = join(source, 'packages/format');
  const exports = { '.': { import: './dist/index.js', types: './dist/index.d.ts' } };
  put(join(source, 'LICENSE'), 'Application license');
  put(join(source, 'apps/web/package.json'), { dependencies: {} });
  put(join(cli, 'package.json'), {
    name: '@storyboard-viewer/cli',
    version: '1.0.0',
    exports,
    dependencies: { '@storyboard-viewer/format': 'workspace:*' },
  });
  put(join(format, 'package.json'), {
    name: '@storyboard-viewer/format',
    version: '1.0.0',
    exports,
  });
  for (const name of ['index.js', 'index.d.ts', 'cli.js']) put(join(cli, 'dist', name), name);
  for (const name of ['index.js', 'index.d.ts']) put(join(format, 'dist', name), name);
  const web = join(source, 'apps/web/dist');
  for (const name of [
    'index.html',
    'sw.js',
    'manifest.webmanifest',
    'assets/app.js',
    'assets/app.css',
    'assets/font.woff2',
    'examples/film.sbd',
  ])
    put(join(web, name), name);
  put(join(source, 'apps/web/public/examples/film.sbd'), 'examples/film.sbd');
  cpSync(web, join(cli, 'web'), { recursive: true });
  cpSync(cli, deployed, { recursive: true });
  const target = join(deployed, 'node_modules/.pnpm/format/node_modules/@storyboard-viewer/format');
  cpSync(format, target, { recursive: true });
  mkdirSync(join(deployed, 'node_modules/@storyboard-viewer'), { recursive: true });
  symlinkSync(
    '../.pnpm/format/node_modules/@storyboard-viewer/format',
    join(deployed, 'node_modules/@storyboard-viewer/format'),
  );
  const report = [
    {
      name: '@storyboard-viewer/cli',
      version: '1.0.0',
      path: cli,
      dependencies: { '@storyboard-viewer/format': { version: 'link:../format', path: format } },
    },
  ];
  return { source, deployed, report, put, check: () => checkPackage(source, deployed, report) };
}

test('accepts complete compiled output and internal pnpm links', (t) => {
  const f = fixture(t);
  f.check();
  assert.deepEqual(installedGraph(f.deployed), dependencyGraph(f.report));
});

for (const path of [
  'dist/cli.js',
  'dist/index.js',
  'node_modules/@storyboard-viewer/format/dist/index.d.ts',
  'web/index.html',
  'web/sw.js',
  'web/assets/app.js',
  'web/assets/font.woff2',
  'web/examples/film.sbd',
]) {
  test(`rejects missing deployed output: ${path}`, (t) => {
    const f = fixture(t);
    rmSync(join(f.deployed, path));
    assert.throws(f.check);
  });
}

test('rejects missing web build, even if the copy helper previously succeeded', (t) => {
  const f = fixture(t);
  rmSync(join(f.source, 'apps/web/dist'), { recursive: true });
  assert.throws(f.check);
});

test('rejects changed lazy browser chunks', (t) => {
  const f = fixture(t);
  f.put(join(f.deployed, 'web/assets/app.js'), 'different');
  assert.throws(f.check, /Deployed web copy is incomplete/);
});

test('rejects a changed production version', (t) => {
  const f = fixture(t);
  f.put(join(f.deployed, 'node_modules/@storyboard-viewer/format/package.json'), {
    name: '@storyboard-viewer/format',
    version: '2.0.0',
  });
  assert.throws(f.check, /production graph changed/);
});

test('rejects escaping and broken package links', (t) => {
  const f = fixture(t);
  symlinkSync(f.source, join(f.deployed, 'outside'));
  assert.throws(f.check, /Escaping package link/);
  rmSync(join(f.deployed, 'outside'));
  symlinkSync(join(f.source, 'missing'), join(f.deployed, 'broken'));
  assert.throws(f.check);
});

test('rejects unused development dependencies and source directories', (t) => {
  const f = fixture(t);
  f.put(join(f.deployed, 'node_modules/dev-tool/package.json'), {
    name: 'dev-tool',
    version: '1.0.0',
  });
  assert.throws(f.check, /Non-production package/);
  rmSync(join(f.deployed, 'node_modules/dev-tool'), { recursive: true });
  mkdirSync(join(f.deployed, 'src'));
  assert.throws(f.check, /Development directory/);
});

test('metadata provisioning uses exact installed versions, not manifest ranges', (t) => {
  const f = fixture(t);
  const path = join(f.source, 'external');
  f.put(join(path, 'package.json'), { name: 'example', version: '1.2.3' });
  const reports = [
    {
      dependencies: {
        example: { path, version: '1.2.3' },
        format: { path: f.source, version: 'link:../format' },
      },
    },
  ];
  assert.deepEqual(metadataManifest(reports), {
    private: true,
    dependencies: { cache1: 'npm:example@1.2.3' },
  });
});
