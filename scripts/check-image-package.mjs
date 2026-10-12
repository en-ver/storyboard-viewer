// Build-only checks: pnpm 8 deploy is offline but internally disables frozen-lockfile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

  // Keep application and bundled font licenses, as well as dependency package notices.
  copyFileSync(join(source, 'LICENSE'), join(deployed, 'LICENSE'));
  copyFileSync(join(source, 'LICENSE'), join(format, 'LICENSE'));
  const require = createRequire(join(source, 'apps/web/package.json'));
  for (const name of Object.keys(json(join(source, 'apps/web/package.json')).dependencies)) {
    if (!name.startsWith('@fontsource/')) continue;
    const root = dirname(require.resolve(`${name}/package.json`));
    const notices = readdirSync(root).filter((file) => /^(license|ofl)(\.|$)/i.test(file));
    assert(notices.length, `Missing font license: ${name}`);
    const dest = join(deployed, 'licenses', name);
    mkdirSync(dest, { recursive: true });
    for (const file of notices) copyFileSync(join(root, file), join(dest, file));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, deployed, before] = process.argv.slice(2);
  if (source === '--metadata') {
    mkdirSync(deployed, { recursive: true });
    writeFileSync(join(deployed, 'package.json'), JSON.stringify(metadataManifest(json(before))));
  } else {
    checkPackage(source, deployed, json(before));
    console.log(
      'Image package verified: compiled outputs, web assets, locked production graph, links and licenses',
    );
  }
}
