// Build-only checks: pnpm 8 deploy is offline but internally disables frozen-lockfile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
};

export function files(root) {
  const result = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      assert(!entry.isSymbolicLink(), `Unexpected output link: ${path}`);
      if (entry.isDirectory()) visit(path);
      else {
        assert(entry.isFile(), `Unexpected output entry: ${path}`);
        result[relative(root, path)] = hash(path);
      }
    }
  }
  visit(root);
  assert(Object.keys(result).length, `Empty output: ${root}`);
  return result;
}

export function dependencyGraph(report) {
  assert.equal(report.length, 1, 'Expected one CLI dependency report');
  const edges = new Set();
  const packages = new Set();
  function visit(pkg) {
    const manifest = json(join(pkg.path, 'package.json'));
    const id = `${manifest.name}@${manifest.version}`;
    packages.add(id);
    for (const [alias, child] of Object.entries({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      const childManifest = json(join(child.path, 'package.json'));
      const edge = `${id} -> ${alias}=${childManifest.name}@${childManifest.version}`;
      if (edges.has(edge)) continue;
      edges.add(edge);
      visit(child);
    }
  }
  visit(report[0]);
  return { edges: [...edges].toSorted(), packages: [...packages].toSorted() };
}

function findDependency(packageRoot, name) {
  for (let dir = packageRoot; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

// Use installed manifests: pnpm 8 deploy does not write a wanted lockfile in its output.
export function installedGraph(root) {
  const edges = new Set();
  const packages = new Set();
  const seen = new Set();
  function visit(packageRoot) {
    packageRoot = realpathSync(packageRoot);
    if (seen.has(packageRoot)) return;
    seen.add(packageRoot);
    const pkg = json(join(packageRoot, 'package.json'));
    const id = `${pkg.name}@${pkg.version}`;
    packages.add(id);
    for (const name of new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ])) {
      // An undeclared optional peer can be visible through pnpm's hoisted lookup;
      // that does not make it a locked dependency edge of this package.
      if (
        pkg.peerDependenciesMeta?.[name]?.optional &&
        !pkg.dependencies?.[name] &&
        !pkg.optionalDependencies?.[name]
      )
        continue;
      const target = findDependency(packageRoot, name);
      if (!target) {
        assert(
          !pkg.dependencies?.[name] || pkg.optionalDependencies?.[name],
          `Missing dependency: ${id} -> ${name}`,
        );
        continue;
      }
      const child = json(join(target, 'package.json'));
      edges.add(`${id} -> ${name}=${child.name}@${child.version}`);
      visit(target);
    }
  }
  visit(root);
  return { edges: [...edges].toSorted(), packages: [...packages].toSorted() };
}

// Provision pnpm's metadata cache with exact installed workspace dependency versions.
// This disposable manifest does not replace or update the frozen source lockfile.
export function metadataManifest(reports) {
  const dependencies = {};
  const seen = new Set();
  for (const report of reports) {
    for (const child of Object.values({
      ...report.dependencies,
      ...report.devDependencies,
      ...report.optionalDependencies,
    })) {
      if (child.version.startsWith('link:')) continue;
      const pkg = json(join(child.path, 'package.json'));
      const id = `${pkg.name}@${pkg.version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      dependencies[`cache${seen.size}`] = `npm:${id}`;
    }
  }
  return { private: true, dependencies };
}

export function checkLinks(root, allowedPackages) {
  const physicalRoot = realpathSync(root);
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        assert(inside(physicalRoot, realpathSync(path)), `Escaping package link: ${path}`);
      } else if (entry.isDirectory()) {
        // Every installed package, including transitive dependencies, must be production-locked.
        if (entry.name === 'node_modules') checkPackages(path);
        visit(path);
      }
    }
  }
  function checkPackages(modules) {
    for (const name of readdirSync(modules)) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) {
        for (const child of readdirSync(join(modules, name)))
          checkInstalledPackage(join(modules, name, child));
      } else checkInstalledPackage(join(modules, name));
    }
  }
  function checkInstalledPackage(path) {
    const pkg = json(join(path, 'package.json'));
    assert(
      allowedPackages.has(`${pkg.name}@${pkg.version}`),
      `Non-production package: ${pkg.name}`,
    );
  }
  visit(root);
}

// This npm release omits its upstream license. Registry gitHead identifies
// the exact source revision; retain verified upstream bytes, never infer authors.
const upstreamBrowserNotices = {
  '@cfworker/json-schema@4.1.1': {
    url: 'https://raw.githubusercontent.com/cfworker/cfworker/5409fdc2bd144f68e8b28c61c71fcb16600000a6/LICENSE.md',
    sha256: '376944252ab78ca6b41aee44ddea8894927ee67891e77e61eb9d59af63e35094',
  },
};

// hls.js/light ships a prebuilt bundle. Its own map names the first three
// modules; cml-id3's peer and the emitted utility functions identify cml-utils.
// These exact versions come from hls.js 1.7.3's published build manifest.
const hlsBundledNotices = {
  'url-toolkit': {
    version: '2.2.5',
    files: {
      LICENSE: {
        url: 'https://raw.githubusercontent.com/tjenkinson/url-toolkit/d02ff136835786a00c55c0e69e38dd7cc26d5acc/LICENSE',
        sha256: '0fa4bd51fab4d066970c481917d77f222253ee82344caf07efd03801aa558dff',
      },
    },
  },
  eventemitter3: {
    version: '5.0.4',
    files: {
      LICENSE: {
        url: 'https://raw.githubusercontent.com/primus/eventemitter3/b0144e940ace8add8f335a8adfbed9284eb419f3/LICENSE',
        sha256: '3aecc12b1cb28832b5f65ab64291de96568c3f236a74d646281b4491f7bcadbf',
      },
    },
  },
  '@svta/cml-id3': {
    version: '1.0.6',
    files: {
      LICENSE: {
        url: 'https://raw.githubusercontent.com/streaming-video-technology-alliance/common-media-library/244ecf05132ae1d1dc9cbd01479fd88f7695dbce/libs/id3/LICENSE',
        sha256: '95cdf13a152329c8a60cf739d442f578a172727f0584bff42406126719312f62',
      },
      'NOTICE.md': {
        url: 'https://raw.githubusercontent.com/streaming-video-technology-alliance/common-media-library/244ecf05132ae1d1dc9cbd01479fd88f7695dbce/libs/id3/NOTICE.md',
        sha256: '358b37b8ed1d8c6a40d22b3deb41c59f4532ca8e05eb6647ad2d1614f11ee90b',
      },
    },
  },
  '@svta/cml-utils': {
    version: '1.5.0',
    files: {
      LICENSE: {
        url: 'https://raw.githubusercontent.com/streaming-video-technology-alliance/common-media-library/244ecf05132ae1d1dc9cbd01479fd88f7695dbce/libs/utils/LICENSE',
        sha256: '95cdf13a152329c8a60cf739d442f578a172727f0584bff42406126719312f62',
      },
    },
  },
};

async function downloadNotice(upstream, path) {
  const response = await fetch(upstream.url, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `Cannot retrieve browser notice: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    upstream.sha256,
    `Upstream browser notice changed: ${upstream.url}`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export async function prepareBrowserNotices(source) {
  const root = findDependency(join(source, 'packages/format'), '@cfworker/json-schema');
  assert(root, 'Missing installed @cfworker/json-schema');
  const pkg = json(join(root, 'package.json'));
  const id = `${pkg.name}@${pkg.version}`;
  const upstream = upstreamBrowserNotices[id];
  assert(upstream, `Unreviewed upstream browser notice: ${id}`);
  await downloadNotice(upstream, join(source, 'node_modules/.image-notices', id, 'LICENSE.md'));
  const hlsRoot = findDependency(join(source, 'apps/web'), 'hls.js');
  const hls = json(join(hlsRoot, 'package.json'));
  assert.equal(hls.version, '1.7.3', 'Unreviewed hls.js prebuilt bundle');
  const nested = json(join(hlsRoot, 'dist/hls.light.mjs.map')).sources.filter((path) =>
    path.startsWith('node_modules/'),
  );
  assert.deepEqual(
    nested,
    [
      'node_modules/url-toolkit/src/url-toolkit.js',
      'node_modules/@svta/cml-id3/dist/index.js',
      'node_modules/eventemitter3/index.js',
    ],
    'Unreviewed hls.js bundled modules',
  );
  for (const [name, notice] of Object.entries(hlsBundledNotices)) {
    assert.equal(hls.devDependencies[name], notice.version, `Changed prebundled version: ${name}`);
    const response = await fetch(`https://registry.npmjs.org/${name}/${notice.version}`, {
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `Cannot read prebundled package metadata: ${name}`);
    const metadata = await response.json();
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, notice.version);
    const dest = join(
      source,
      'node_modules/.image-notices/prebundled',
      `${name}@${notice.version}`,
    );
    for (const [file, origin] of Object.entries(notice.files))
      await downloadNotice(origin, join(dest, file));
    // This is notice metadata only. Do not install or execute bundled packages.
    writeFileSync(
      join(dest, 'package.json'),
      JSON.stringify(
        {
          name,
          version: metadata.version,
          license: metadata.license,
          repository: metadata.repository,
          prebundledIn: 'hls.js@1.7.3',
          noticeSources: notice.files,
        },
        null,
        2,
      ) + '\n',
    );
  }
}

// Maps are produced only for image builds. They cover lazy chunks and the
// separately bundled Workbox service worker, not just manifest dependencies.
export function browserPackages(source) {
  const web = join(source, 'apps/web/dist');
  const output = files(web);
  const publicFiles = files(join(source, 'apps/web/public'));
  const roots = new Set();
  for (const file of Object.keys(output).filter((path) => path.endsWith('.js'))) {
    if (publicFiles[file]) continue;
    const mapPath = join(web, `${file}.map`);
    assert(existsSync(mapPath), `Missing browser module map: ${file}`);
    const map = json(mapPath);
    assert(Array.isArray(map.sources) && map.sources.length, `Empty browser module map: ${file}`);
    for (const module of map.sources) {
      const offset = module.indexOf('node_modules/');
      if (offset < 0) continue;
      let path = resolve(dirname(mapPath), map.sourceRoot ?? '', module);
      // Workbox's maps use paths relative to its intermediate build, rather
      // than the final map. Resolve the exact installed pnpm path in that case.
      if (!existsSync(path)) path = resolve(source, module.slice(offset));
      assert(existsSync(path), `Missing bundled module source: ${module}`);
      path = realpathSync(path);
      assert(inside(realpathSync(source), path), `External bundled module: ${module}`);
      // Ignore nested package.json files that only specify type: module.
      for (let root = dirname(path); ; root = dirname(root)) {
        const manifest = join(root, 'package.json');
        if (existsSync(manifest) && json(manifest).name) {
          if (!inside(realpathSync(join(source, 'packages')), root)) roots.add(root);
          break;
        }
        assert(dirname(root) !== root, `Missing bundled package manifest: ${module}`);
      }
    }
  }
  const prebundled = [];
  for (const root of roots) {
    const pkg = json(join(root, 'package.json'));
    if (pkg.name === 'hls.js' && pkg.version === '1.7.3') {
      for (const [name, notice] of Object.entries(hlsBundledNotices)) {
        prebundled.push(
          join(source, 'node_modules/.image-notices/prebundled', `${name}@${notice.version}`),
        );
      }
    }
  }
  for (const root of prebundled) roots.add(root);
  // Font binary assets do not appear in JavaScript maps.
  const require = createRequire(join(source, 'apps/web/package.json'));
  for (const name of Object.keys(json(join(source, 'apps/web/package.json')).dependencies)) {
    if (name.startsWith('@fontsource/'))
      roots.add(dirname(require.resolve(`${name}/package.json`)));
  }
  assert(roots.size, 'Missing browser dependency inventory');
  return [...roots].toSorted();
}

export function copyBrowserNotices(source, deployed, roots = browserPackages(source)) {
  const licenses = join(deployed, 'licenses');
  const originalWeb = files(join(deployed, 'web'));
  const publicFiles = files(join(source, 'apps/web/public'));
  const generatedMaps = new Set(
    Object.keys(originalWeb).filter((path) => path.endsWith('.js.map') && !publicFiles[path]),
  );
  const inventory = [];
  const notices = [
    'Browser third-party notices',
    'Package names, versions and license identifiers come from the installed packages.',
    'The original notices below apply to those packages, not to the entire application.',
    'This directory is also served at ./licenses/ by the image web application.',
    'File index: ./licenses/packages.json lists each package and its notice and source file paths.',
  ];
  const seen = new Set();
  for (const root of roots) {
    const pkg = json(join(root, 'package.json'));
    assert(/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg.name), 'Invalid bundled package name');
    assert(/^[\w.+-]+$/.test(pkg.version), `Invalid bundled package version: ${pkg.name}`);
    const id = `${pkg.name}@${pkg.version}`;
    assert(!seen.has(id), `Duplicate bundled package: ${id}`);
    seen.add(id);
    assert(
      ['MIT', 'Apache-2.0', 'MPL-2.0', 'OFL-1.1'].includes(pkg.license),
      `Unreviewed browser license: ${id} (${pkg.license})`,
    );
    const dest = join(licenses, pkg.name, pkg.version);
    mkdirSync(dest, { recursive: true });
    const originals = {};
    function copyNotices(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const path = join(dir, entry.name);
        assert(!entry.isSymbolicLink(), `Unexpected notice source link: ${path}`);
        if (entry.isDirectory()) copyNotices(path);
        else if (/^(licen[cs]e|copying|notice|copyright|ofl)([.-]|$)/i.test(entry.name)) {
          assert(readFileSync(path).length, `Empty browser notice: ${path}`);
          const rel = relative(root, path);
          mkdirSync(dirname(join(dest, rel)), { recursive: true });
          copyFileSync(path, join(dest, rel));
          originals[rel] = hash(path);
        }
      }
    }
    copyNotices(root);
    if (pkg.prebundledIn) {
      assert.equal(pkg.prebundledIn, 'hls.js@1.7.3');
      const notice = hlsBundledNotices[pkg.name];
      assert.equal(pkg.version, notice?.version, `Unreviewed prebundled notice: ${id}`);
      for (const [file, origin] of Object.entries(notice.files))
        assert.equal(originals[file], origin.sha256, `Unverified prebundled notice: ${id}/${file}`);
    }
    const upstream = upstreamBrowserNotices[id];
    if (upstream) {
      const path = join(source, 'node_modules/.image-notices', id, 'LICENSE.md');
      assert.equal(hash(path), upstream.sha256, `Unverified upstream browser notice: ${id}`);
      copyFileSync(path, join(dest, 'LICENSE.md'));
      originals['LICENSE.md'] = hash(path);
      notices.push(`Original notice source: ${upstream.url}`);
    }
    assert(
      Object.keys(originals).some((file) => /^(licen[cs]e|copying|ofl)/i.test(file)),
      `Missing browser license: ${id}`,
    );
    copyFileSync(join(root, 'package.json'), join(dest, 'package.json'));
    const entry = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      notices: originals,
    };
    if (pkg.prebundledIn) entry.prebundledIn = pkg.prebundledIn;
    notices.push(`\n${id} (${pkg.license})`);
    if (pkg.prebundledIn)
      notices.push(
        `Included in the prebuilt ${pkg.prebundledIn} browser bundle. Original notice sources: ${JSON.stringify(pkg.noticeSources)}`,
      );
    for (const file of Object.keys(originals).toSorted()) {
      notices.push(
        `--- ${pkg.name}/${pkg.version}/${file} ---`,
        readFileSync(join(dest, file), 'utf8'),
      );
    }
    if (pkg.license === 'Apache-2.0') {
      // hls.js ships its attribution and an Apache URL, not the complete terms.
      // TypeScript's frozen installed package includes the standard full text.
      const apache = join(source, 'node_modules/typescript/LICENSE.txt');
      const text = readFileSync(apache, 'utf8');
      assert(
        text.includes('Grant of Patent License') && text.includes('END OF TERMS AND CONDITIONS'),
        'Incomplete Apache license text',
      );
      copyFileSync(apache, join(dest, 'Apache-2.0.txt'));
      notices.push('--- Apache-2.0 terms (from installed TypeScript LICENSE.txt) ---', text);
    }
    if (pkg.license === 'MPL-2.0') {
      // Mediabunny publishes its preferred TypeScript source in the npm package.
      // Ship it byte-for-byte, with its original file headers and package README.
      entry.source = files(join(root, 'src'));
      cpSync(join(root, 'src'), join(dest, 'src'), { recursive: true });
      assert.deepEqual(files(join(dest, 'src')), entry.source, `Incomplete MPL source: ${id}`);
      copyFileSync(join(root, 'README.md'), join(dest, 'README.md'));
      notices.push(
        `Source availability: ${pkg.name}/${pkg.version}/src/ contains the complete, unmodified Source Code Form from this installed package.`,
        'This source is governed by MPL-2.0; see the LICENSE and original source headers in that directory.',
        'Browser recipients can obtain these files without charge at ./licenses/ (relative to the application URL).',
      );
    }
    inventory.push(entry);
  }
  writeFileSync(join(licenses, 'packages.json'), JSON.stringify(inventory, null, 2) + '\n');
  writeFileSync(join(licenses, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n') + '\n');
  cpSync(licenses, join(deployed, 'web/licenses'), { recursive: true });
  assert.deepEqual(
    files(join(deployed, 'web/licenses')),
    files(licenses),
    'Browser notices copy is incomplete',
  );
  // Maps are build evidence, not runtime assets. Workbox emits map footer links;
  // remove only that generated footer when removing its map.
  for (const file of generatedMaps) {
    const script = join(deployed, 'web', file.slice(0, -4));
    const text = readFileSync(script, 'utf8');
    writeFileSync(script, text.replace(/\n\/\/# sourceMappingURL=[^\n]+\s*$/, '\n'));
    rmSync(join(deployed, 'web', file));
  }
  const index = join(deployed, 'web/index.html');
  const html = readFileSync(index, 'utf8');
  assert(html.includes('</head>'), 'Missing web document head');
  writeFileSync(
    index,
    html.replace(
      '</head>',
      '<link rel="license" href="./licenses/THIRD-PARTY-NOTICES.txt">\n</head>',
    ),
  );
  // Verify the final payload still contains every original runtime asset.
  // Only build maps, their footer links and the license discovery link differ.
  const finalWeb = files(join(deployed, 'web'));
  for (const file of Object.keys(originalWeb)) {
    if (generatedMaps.has(file)) {
      assert(!finalWeb[file], `Build map in runtime: ${file}`);
      continue;
    }
    let bytes = readFileSync(join(source, 'apps/web/dist', file));
    if (file === 'index.html')
      bytes = Buffer.from(
        bytes
          .toString('utf8')
          .replace(
            '</head>',
            '<link rel="license" href="./licenses/THIRD-PARTY-NOTICES.txt">\n</head>',
          ),
      );
    else if (generatedMaps.has(`${file}.map`))
      bytes = Buffer.from(
        bytes.toString('utf8').replace(/\n\/\/# sourceMappingURL=[^\n]+\s*$/, '\n'),
      );
    assert.equal(
      finalWeb[file],
      createHash('sha256').update(bytes).digest('hex'),
      `Changed runtime web asset: ${file}`,
    );
  }
  return inventory;
}

export function checkPackage(source, deployed, sourceReport) {
  const expected = dependencyGraph(sourceReport);
  assert.deepEqual(installedGraph(deployed), expected, 'Deployed production graph changed');
  checkLinks(deployed, new Set(expected.packages));
  for (const forbidden of ['src', 'test', 'scripts', 'apps', 'packages']) {
    assert(!readdirSync(deployed).includes(forbidden), `Development directory: ${forbidden}`);
  }

  const sourceCli = join(source, 'packages/cli');
  const format = join(deployed, 'node_modules/@storyboard-viewer/format');
  const cliManifest = json(join(deployed, 'package.json'));
  const formatManifest = json(join(format, 'package.json'));
  for (const [root, manifest] of [
    [deployed, cliManifest],
    [format, formatManifest],
  ]) {
    for (const exp of Object.values(manifest.exports)) {
      for (const condition of ['import', 'types']) {
        const path = resolve(root, exp[condition]);
        assert(inside(resolve(root), path), `Escaping export: ${path}`);
        assert(lstatSync(path).isFile(), `Missing compiled export: ${path}`);
      }
    }
  }
  assert(lstatSync(join(deployed, 'dist/cli.js')).isFile(), 'Missing CLI entry point');
  assert.deepEqual(
    files(join(deployed, 'dist')),
    files(join(sourceCli, 'dist')),
    'CLI output changed',
  );
  assert.deepEqual(
    files(join(format, 'dist')),
    files(join(source, 'packages/format/dist')),
    'Format output changed',
  );

  const web = files(join(source, 'apps/web/dist'));
  for (const required of ['index.html', 'sw.js', 'manifest.webmanifest']) {
    assert(web[required], `Missing web output: ${required}`);
  }
  for (const extension of ['.js', '.css', '.woff2']) {
    assert(
      Object.keys(web).some((path) => path.startsWith(`assets${sep}`) && path.endsWith(extension)),
      `Missing web assets: ${extension}`,
    );
  }
  const publicFiles = files(join(source, 'apps/web/public'));
  for (const [path, digest] of Object.entries(publicFiles)) {
    assert.equal(web[path], digest, `Missing or changed public asset: ${path}`);
  }
  assert.deepEqual(files(join(sourceCli, 'web')), web, 'CLI web copy is incomplete');
  assert.deepEqual(files(join(deployed, 'web')), web, 'Deployed web copy is incomplete');

  // pnpm retains CLI dependency notices. Browser-only modules need their own
  // notices, including transitives, compiler runtime and service-worker modules.
  copyFileSync(join(source, 'LICENSE'), join(deployed, 'LICENSE'));
  copyFileSync(join(source, 'LICENSE'), join(format, 'LICENSE'));
  copyBrowserNotices(source, deployed);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, deployed, before] = process.argv.slice(2);
  if (source === '--browser-notices') {
    await prepareBrowserNotices(deployed);
  } else if (source === '--metadata') {
    mkdirSync(deployed, { recursive: true });
    writeFileSync(join(deployed, 'package.json'), JSON.stringify(metadataManifest(json(before))));
  } else {
    checkPackage(source, deployed, json(before));
    console.log(
      'Image package verified: compiled outputs, web assets, locked production graph, links and licenses',
    );
  }
}
