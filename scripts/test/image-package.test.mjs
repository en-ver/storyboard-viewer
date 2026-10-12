import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import {
  browserPackages,
  checkPackage,
  copyBrowserNotices,
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
  put(join(web, 'index.html'), '<html><head></head><body></body></html>');
  const browser = join(source, 'node_modules/browser-runtime');
  put(join(browser, 'package.json'), { name: 'browser-runtime', version: '1.0.0', license: 'MIT' });
  put(join(browser, 'index.js'), 'export const runtime = true;');
  put(join(browser, 'LICENSE'), 'Copyright actual upstream author\nMIT permission notice');
  put(join(web, 'assets/app.js.map'), {
    sources: [relative(join(web, 'assets'), join(browser, 'index.js'))],
  });
  put(join(web, 'sw.js.map'), { sources: ['generated-sw.js'] });
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
  function syncWeb() {
    cpSync(web, join(cli, 'web'), { recursive: true });
    cpSync(web, join(deployed, 'web'), { recursive: true });
  }
  function addBrowser(name, license = 'MIT', chunk = 'assets/app.js') {
    const browserRoot = join(source, 'node_modules', name);
    put(join(browserRoot, 'package.json'), { name, version: '1.0.0', license });
    put(join(browserRoot, 'dist/package.json'), { type: 'module' });
    put(join(browserRoot, 'dist/index.js'), 'export const value = true;');
    put(join(browserRoot, 'LICENSE'), `Original ${name} license and copyright`);
    const path = join(web, `${chunk}.map`);
    const map = JSON.parse(readFileSync(path, 'utf8'));
    map.sources.push(relative(dirname(path), join(browserRoot, 'dist/index.js')));
    put(path, map);
    syncWeb();
    return browserRoot;
  }
  return {
    source,
    deployed,
    report,
    put,
    browser,
    web,
    addBrowser,
    syncWeb,
    check: () => checkPackage(source, deployed, report),
  };
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

test('discovers transitive, compiler and lazy/service-worker modules, not unused build tools', (t) => {
  const f = fixture(t);
  const transitive = f.addBrowser('@example/transitive');
  const compiler = f.addBrowser('compiler-runtime');
  f.put(join(f.web, 'lazy.js'), 'lazy');
  f.put(join(f.web, 'lazy.js.map'), { sources: [] });
  const lazy = f.addBrowser('lazy-runtime', 'MIT', 'lazy.js');
  f.put(join(f.web, 'workbox.js'), 'worker\n//# sourceMappingURL=workbox.js.map\n');
  // Workbox paths can be relative to its intermediate build, not the output.
  f.put(join(f.web, 'workbox.js.map'), {
    sources: ['../../node_modules/browser-runtime/index.js'],
  });
  const worker = f.addBrowser('worker-runtime', 'MIT', 'workbox.js');
  f.put(join(f.source, 'node_modules/unused-build-tool/package.json'), {
    name: 'unused-build-tool',
  });
  assert.deepEqual(
    new Set(browserPackages(f.source)),
    new Set([f.browser, transitive, compiler, lazy, worker].map((path) => realpathSync(path))),
  );
  f.check();
  assert(!readFileSync(join(f.deployed, 'web/workbox.js'), 'utf8').includes('sourceMappingURL'));
});

test('preserves committed public scripts and maps rather than treating them as build evidence', (t) => {
  const f = fixture(t);
  for (const file of ['public-script.js', 'public-script.js.map']) {
    f.put(join(f.source, 'apps/web/public', file), 'Original committed public asset');
    f.put(join(f.web, file), 'Original committed public asset');
  }
  f.syncWeb();
  f.check();
  assert.equal(
    readFileSync(join(f.deployed, 'web/public-script.js.map'), 'utf8'),
    'Original committed public asset',
  );
});

test('retains non-font MIT licenses, additional NOTICE/COPYING files and web access', (t) => {
  const f = fixture(t);
  const root = f.addBrowser('konva');
  f.put(join(root, 'NOTICE.txt'), 'Upstream additional attribution');
  f.put(join(root, 'docs/COPYING'), 'Separate upstream terms');
  f.check();
  for (const file of ['LICENSE', 'NOTICE.txt', 'docs/COPYING', 'package.json']) {
    assert.deepEqual(
      readFileSync(join(f.deployed, 'licenses/konva/1.0.0', file)),
      readFileSync(join(root, file)),
    );
    assert.deepEqual(
      readFileSync(join(f.deployed, 'web/licenses/konva/1.0.0', file)),
      readFileSync(join(root, file)),
    );
  }
  assert.match(
    readFileSync(join(f.deployed, 'licenses/THIRD-PARTY-NOTICES.txt'), 'utf8'),
    /Original konva license and copyright/,
  );
  assert.match(readFileSync(join(f.deployed, 'web/index.html'), 'utf8'), /rel="license"/);
  const records = JSON.parse(readFileSync(join(f.deployed, 'licenses/packages.json'), 'utf8'));
  assert(records.every((pkg) => !Object.hasOwn(pkg, 'author')));
});

test('retains the full original StackBlur source notice in the index and served artifacts', (t) => {
  const f = fixture(t);
  const root = f.addBrowser('konva');
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const original = readFileSync(require.resolve('konva/lib/filters/Blur.js'), 'utf8');
  assert.match(original, /Copyright \(c\) 2010 Mario Klingemann/);
  assert.match(original, /Permission is hereby granted, free of charge/);
  assert.match(original, /included in all copies or substantial portions of the Software/);
  assert.match(original, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.match(original, /OTHER DEALINGS IN THE SOFTWARE/);
  f.put(join(root, 'lib/filters/Blur.js'), original);
  const mapPath = join(f.web, 'assets/app.js.map');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  map.sources.push(relative(dirname(mapPath), join(root, 'lib/filters/Blur.js')));
  f.put(mapPath, map);
  f.syncWeb();
  f.check();
  const file = 'embedded/lib/filters/Blur.js';
  for (const dir of ['licenses', 'web/licenses'])
    assert.equal(readFileSync(join(f.deployed, dir, 'konva/1.0.0', file), 'utf8'), original);
  const records = JSON.parse(readFileSync(join(f.deployed, 'licenses/packages.json'), 'utf8'));
  assert(records.find((pkg) => pkg.name === 'konva').notices[file]);
  assert(
    readFileSync(join(f.deployed, 'licenses/THIRD-PARTY-NOTICES.txt'), 'utf8').includes(original),
  );
});

test('copies mapped source headers without rewriting terms, not unrelated package sources', (t) => {
  const f = fixture(t);
  const root = f.addBrowser('worker-runtime');
  const original =
    '/*\r\n Copyright 2020 Google LLC\r\n MIT-style license in LICENSE\r\n*/\r\nexport const worker = true;\r\n';
  f.put(join(root, 'dist/index.js'), original);
  f.put(join(root, 'unused.js'), '/*! Copyright an unrelated source author */');
  f.check();
  assert.equal(
    readFileSync(
      join(f.deployed, 'web/licenses/worker-runtime/1.0.0/embedded/dist/index.js'),
      'utf8',
    ),
    original,
  );
  const records = JSON.parse(readFileSync(join(f.deployed, 'licenses/packages.json'), 'utf8'));
  const record = records.find((pkg) => pkg.name === 'worker-runtime');
  assert(record.notices['embedded/dist/index.js']);
  assert(!record.notices['embedded/unused.js']);
  assert(!record.notices['embedded/package.json']);
});

test('retains font notices alongside JavaScript notices', (t) => {
  const f = fixture(t);
  const name = '@fontsource/example';
  f.put(join(f.source, 'apps/web/package.json'), { dependencies: { [name]: '1.0.0' } });
  const root = join(f.source, 'apps/web/node_modules', name);
  f.put(join(root, 'package.json'), { name, version: '1.0.0', license: 'OFL-1.1' });
  f.put(join(root, 'OFL.txt'), 'Original font copyright and OFL terms');
  f.check();
  assert.equal(
    readFileSync(join(f.deployed, 'licenses', name, '1.0.0/OFL.txt'), 'utf8'),
    'Original font copyright and OFL terms',
  );
});

for (const invalid of ['missing', 'empty']) {
  test(`rejects ${invalid} bundled JavaScript license`, (t) => {
    const f = fixture(t);
    if (invalid === 'missing') rmSync(join(f.browser, 'LICENSE'));
    else f.put(join(f.browser, 'LICENSE'), '');
    assert.throws(f.check, /Missing browser license|Empty browser notice/);
  });
}

test('ships complete byte-identical MPL source, headers and source-availability notice', (t) => {
  const f = fixture(t);
  const root = f.addBrowser('mediabunny', 'MPL-2.0');
  f.put(
    join(root, 'src/index.ts'),
    '/*! Original MPL copyright header */\nexport * from "./nested/helper";',
  );
  f.put(join(root, 'src/nested/helper.ts'), '/*! Another original MPL header */');
  f.put(join(root, 'README.md'), 'Original upstream license guidance');
  f.check();
  for (const file of ['src/index.ts', 'src/nested/helper.ts', 'README.md']) {
    assert.deepEqual(
      readFileSync(join(f.deployed, 'web/licenses/mediabunny/1.0.0', file)),
      readFileSync(join(root, file)),
    );
  }
  const records = JSON.parse(readFileSync(join(f.deployed, 'licenses/packages.json'), 'utf8'));
  assert.equal(Object.keys(records.find((p) => p.name === 'mediabunny').source).length, 2);
  assert.match(
    readFileSync(join(f.deployed, 'licenses/THIRD-PARTY-NOTICES.txt'), 'utf8'),
    /Source availability: mediabunny\/1.0.0\/src\//,
  );
});

test('rejects MPL executable packaging without preferred source', (t) => {
  const f = fixture(t);
  f.addBrowser('mediabunny', 'MPL-2.0');
  assert.throws(f.check, /ENOENT/);
});

test('retains Apache attributions plus the full standard terms', (t) => {
  const f = fixture(t);
  f.addBrowser('hls.js', 'Apache-2.0');
  const terms = 'Apache License\nGrant of Patent License\nEND OF TERMS AND CONDITIONS';
  f.put(join(f.source, 'node_modules/typescript/LICENSE.txt'), terms);
  f.check();
  assert.equal(
    readFileSync(join(f.deployed, 'licenses/hls.js/1.0.0/Apache-2.0.txt'), 'utf8'),
    terms,
  );
  assert.match(
    readFileSync(join(f.deployed, 'licenses/THIRD-PARTY-NOTICES.txt'), 'utf8'),
    /Original hls.js license and copyright/,
  );
});

test('rejects missing maps, missing mapped sources and unreviewed license identifiers', (t) => {
  const f = fixture(t);
  rmSync(join(f.web, 'assets/app.js.map'));
  assert.throws(() => browserPackages(f.source), /Missing browser module map/);
  f.put(join(f.web, 'assets/app.js.map'), { sources: ['../../node_modules/missing/index.js'] });
  assert.throws(() => browserPackages(f.source), /Missing bundled module source/);
  f.put(join(f.web, 'assets/app.js.map'), {
    sources: [relative(join(f.web, 'assets'), join(f.browser, 'index.js'))],
  });
  f.put(join(f.browser, 'package.json'), {
    name: 'browser-runtime',
    version: '1.0.0',
    license: 'Unknown',
  });
  assert.throws(
    () => copyBrowserNotices(f.source, f.deployed, [f.browser]),
    /Unreviewed browser license/,
  );
});

test('requires notices for packages hidden inside the hls.js prebuilt bundle', (t) => {
  const f = fixture(t);
  const hls = f.addBrowser('hls.js', 'Apache-2.0');
  f.put(join(hls, 'package.json'), { name: 'hls.js', version: '1.7.3', license: 'Apache-2.0' });
  const roots = browserPackages(f.source);
  for (const id of [
    'url-toolkit@2.2.5',
    'eventemitter3@5.0.4',
    '@svta/cml-id3@1.0.6',
    '@svta/cml-utils@1.5.0',
  ]) {
    assert(roots.includes(join(f.source, 'node_modules/.image-notices/prebundled', id)));
  }
  assert.throws(() => copyBrowserNotices(f.source, f.deployed), /ENOENT/);
});

test('rejects unverified notices for prebundled dependencies', (t) => {
  const f = fixture(t);
  const root = join(f.source, 'prebundled');
  f.put(join(root, 'package.json'), {
    name: 'eventemitter3',
    version: '5.0.4',
    license: 'MIT',
    prebundledIn: 'hls.js@1.7.3',
  });
  f.put(join(root, 'LICENSE'), 'Not the upstream license');
  assert.throws(
    () => copyBrowserNotices(f.source, f.deployed, [root]),
    /Unverified prebundled notice/,
  );
});

test('rejects a fabricated supplemental upstream notice', (t) => {
  const f = fixture(t);
  const root = join(f.source, 'node_modules/@cfworker/json-schema');
  f.put(join(root, 'package.json'), {
    name: '@cfworker/json-schema',
    version: '4.1.1',
    license: 'MIT',
  });
  f.put(
    join(f.source, 'node_modules/.image-notices/@cfworker/json-schema@4.1.1/LICENSE.md'),
    'Guessed author and license',
  );
  assert.throws(
    () => copyBrowserNotices(f.source, f.deployed, [root]),
    /Unverified upstream browser notice/,
  );
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
