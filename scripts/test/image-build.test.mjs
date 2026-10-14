// Opt in with pnpm test:image. Ordinary pnpm test does not require Docker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const enabled = process.env['SBD_DOCKER_TESTS'] === '1';
const selectedImage = process.env['SBD_TEST_IMAGE'];
const selectedRevision = process.env['SBD_TEST_REVISION'];
import { exampleInventory, EXAMPLE_NAMES } from '../check-image-package.mjs';

test('Dockerfile, wrapper and admitted examples match the source package contract', () => {
  const dockerfile = readFileSync(join(repository, 'Dockerfile'), 'utf8');
  const instructions = dockerfile
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
  const jsonInstruction = (name) =>
    JSON.parse(instructions.findLast((line) => line.startsWith(name + ' ')).slice(name.length + 1));
  assert.deepEqual(jsonInstruction('ENTRYPOINT'), ['/app/docker-entrypoint.sh']);
  assert.deepEqual(jsonInstruction('CMD'), []);
  assert.equal(
    instructions.findLast((line) => line.startsWith('USER ')),
    'USER node',
  );
  for (const instruction of [
    'COPY examples/ ./examples/',
    'COPY --from=builder /out/home/ /home/node/',
    'COPY scripts/docker-entrypoint.sh /app/docker-entrypoint.sh',
  ])
    assert(instructions.includes(instruction));
  assert.match(dockerfile, /--frozen-lockfile/);
  assert.match(dockerfile, /sha256sum --check \/tmp\/source-lock.sha256/);
  assert.match(
    dockerfile,
    /check-image-package.mjs \/src \/out\/cli \/tmp\/source-deps.json \/out\/home/,
  );
  assert.match(dockerfile, /chmod 755 \/app\/docker-entrypoint.sh/);
  const wrapper = readFileSync(join(repository, 'scripts/docker-entrypoint.sh'), 'utf8');
  assert.equal(statSync(join(repository, 'scripts/docker-entrypoint.sh')).mode & 0o777, 0o755);
  assert.match(wrapper, /^#!\/bin\/sh\nset -eu/);
  assert.match(wrapper, /if \[ "\$#" -gt 0 \]; then\n    exec node \/app\/dist\/cli.js "\$@"\nfi/);
  assert.match(
    wrapper,
    /set -- serve --workspace \/projects --examples \/home\/node\/examples --host 0.0.0.0 --port 4400/,
  );
  assert.match(
    wrapper,
    /if \[ -n "\$\{SBD_NAME:-\}" \]; then\n    set -- "\$@" --default-project "\$SBD_NAME"\nfi/,
  );
  assert(wrapper.endsWith('exec node /app/dist/cli.js "$@"\n'));
  assert.equal(
    spawnSync('/bin/sh', ['-n', join(repository, 'scripts/docker-entrypoint.sh')]).status,
    0,
  );
  const ignored = readFileSync(join(repository, '.dockerignore'), 'utf8').split('\n');
  const inventory = exampleInventory(repository);
  assert.deepEqual(
    ignored.filter((line) => line.startsWith('!examples/') && !line.endsWith('/')).toSorted(),
    inventory.map((file) => '!examples/' + file.path).toSorted(),
  );
  assert(ignored.includes('!scripts/docker-entrypoint.sh'));
  for (const pattern of [
    '**',
    '**/.git',
    '**/node_modules',
    '**/dist',
    'packages/cli/web',
    '**/.env',
    '**/.env.*',
    '**/.npmrc',
  ])
    assert(ignored.includes(pattern));
});

test(
  'image package runtime and manual build rejection guards (requires Docker)',
  { skip: !enabled, timeout: 600_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'sbd-image-build-'));
    const logs = join(root, 'logs');
    mkdirSync(logs);
    const prebuilt = selectedImage !== undefined || selectedRevision !== undefined;
    const tag = prebuilt ? selectedImage : `storyboard-viewer-test:${basename(root).toLowerCase()}`;
    if (prebuilt) {
      assert.match(tag ?? '', /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/);
      assert.match(selectedRevision ?? '', /^[a-f0-9]{40}$/);
    }
    console.log(`Docker test evidence: ${root}`);
    // Retain logs and disposable inputs for diagnosis; no automatic Docker pruning.
    function docker(args, name) {
      const result = spawnSync('docker', args, {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 300_000,
      });
      writeFileSync(join(logs, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
      assert.ifError(result.error);
      return result;
    }
    if (!prebuilt) {
      assert.equal(docker(['info'], 'readiness').status, 0, 'Docker is not ready');
      assert.notEqual(
        docker(['image', 'inspect', tag], 'tag-collision').status,
        0,
        'Test tag already exists',
      );
    }
    function context(name) {
      const dest = join(root, name);
      cpSync(repository, dest, {
        recursive: true,
        filter: (path) => {
          const entryName = basename(path);
          return (
            ![
              '.git',
              'node_modules',
              'dist',
              'dev-dist',
              'coverage',
              '.tmp',
              'test-results',
              'playwright-report',
              '.vite',
              '.wrangler',
            ].includes(entryName) && resolve(path) !== resolve(repository, 'packages/cli/web')
          );
        },
      });
      assert(!existsSync(join(dest, '.git')));
      assert(!existsSync(join(dest, 'node_modules')));
      assert(!existsSync(join(dest, 'packages/cli/dist')));
      return dest;
    }
    function build(dir, name) {
      return docker(
        ['build', '--progress=plain', '--tag', tag, '--file', join(dir, 'Dockerfile'), dir],
        name,
      );
    }
    const clean = prebuilt ? undefined : context('clean');
    if (!prebuilt)
      assert.equal(
        build(clean, 'clean-build').status,
        0,
        `Clean Git-free build failed; see ${logs}`,
      );
    const image = docker(['image', 'inspect', tag], 'image');
    assert.equal(image.status, 0);
    const info = JSON.parse(image.stdout)[0];
    assert.equal(info.Config.User, 'node');
    assert.deepEqual(info.Config.Entrypoint, ['/app/docker-entrypoint.sh']);
    assert.deepEqual(info.Config.Cmd ?? [], []);
    assert.equal(info.Os, 'linux');
    assert(['arm64', 'amd64'].includes(info.Architecture));
    if (prebuilt) {
      const namespace = tag.slice('ghcr.io/'.length, tag.indexOf('@'));
      assert.equal(
        info.Config.Labels['org.opencontainers.image.source'],
        'https://github.com/' + namespace,
      );
      assert.equal(info.Config.Labels['org.opencontainers.image.revision'], selectedRevision);
    }
    console.log(
      JSON.stringify({
        reference: tag,
        config: info.Id,
        os: info.Os,
        architecture: info.Architecture,
        revision: info.Config.Labels?.['org.opencontainers.image.revision'],
      }),
    );
    function run(args, name) {
      const cidfile = join(root, name + '.cid');
      const result = docker(
        [
          'run',
          '--pull=never',
          '--name',
          basename(root).toLowerCase() + '-' + name,
          '--cidfile',
          cidfile,
          '--user',
          '1000:1000',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--network',
          'none',
          ...(info.Architecture === 'amd64' ? ['--platform', 'linux/amd64'] : []),
          '--tmpfs',
          '/projects:rw,uid=1000,gid=1000,mode=0755',
          '--tmpfs',
          '/config:rw,uid=1000,gid=1000,mode=0755',
          '--tmpfs',
          '/tmp:rw,uid=1000,gid=1000,mode=0755',
          '--env',
          'HOME=/tmp',
          ...args.slice(0, args.indexOf(tag)),
          tag,
          ...args.slice(args.indexOf(tag) + 1),
        ],
        name,
      );
      assert(existsSync(cidfile), 'Owned container CID missing; no blind cleanup');
      const cid = readFileSync(cidfile, 'utf8').trim();
      assert.match(cid, /^[a-f0-9]{64}$/);
      const state = docker(['inspect', cid], name + '-state');
      assert.equal(state.status, 0);
      assert.equal(
        JSON.parse(state.stdout)[0].State.Running,
        false,
        'Owned container is still running',
      );
      assert.equal(docker(['rm', cid], name + '-remove').status, 0);
      return result;
    }
    const corpus = exampleInventory(repository);
    const wrapper = readFileSync(join(repository, 'scripts/docker-entrypoint.sh'), 'utf8');
    const license = readFileSync(join(repository, 'LICENSE'), 'utf8');
    const readme = readFileSync(join(repository, 'examples/README.md'), 'utf8');
    const probe = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    assert.equal(process.getuid(), 1000);
    assert.equal(process.version, 'v24.21.0');
    assert.equal(process.env.NODE_ENV, 'production');
    for (const path of ['/src', '/out', '/app/src', '/app/apps', '/app/packages', '/app/node_modules/typescript', '/app/node_modules/@storyboard-viewer/web', '/opt/pnpm', '/root/.cache/ms-playwright', '/usr/bin/ffmpeg', '/usr/bin/ffprobe']) assert(!fs.existsSync(path), path);
    function walk(dir) { for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const path = dir + '/' + entry.name;
      assert.throws(() => fs.accessSync(path, fs.constants.W_OK), path);
      if (entry.isDirectory()) walk(path);
    }} walk('/app');
    for (const path of ['/app/dist/cli.js', '/app/LICENSE', '/app/licenses/@fontsource/montserrat/5.3.0/LICENSE', '/app/licenses/konva/10.7.1/LICENSE', '/app/licenses/mediabunny/1.61.3/LICENSE', '/app/web/index.html', '/app/web/sw.js']) assert(fs.statSync(path).isFile(), path);
    const crypto = require('node:crypto');
    assert.equal(fs.readFileSync('/app/docker-entrypoint.sh', 'utf8'), ${JSON.stringify(wrapper)});
    assert.equal(fs.statSync('/app/docker-entrypoint.sh').mode & 0o777, 0o755);
    assert.equal(fs.readFileSync('/home/node/LICENSE', 'utf8'), ${JSON.stringify(license)});
    assert.equal(fs.readFileSync('/home/node/EXAMPLES-README.md', 'utf8'), ${JSON.stringify(readme)});
    assert.equal(fs.readFileSync('/home/node/examples/README.md', 'utf8'), ${JSON.stringify(readme)});
    const corpus = ${JSON.stringify(corpus)};
    const actual = [];
    function exampleWalk(dir, prefix = '') {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        assert(!entry.isSymbolicLink());
        if (entry.isDirectory()) exampleWalk(dir + '/' + entry.name, prefix + entry.name + '/');
        else actual.push(prefix + entry.name);
      }
    }
    exampleWalk('/home/node/examples');
    assert.deepEqual(actual.sort(), corpus.map(file => file.path).sort());
    for (const file of corpus) {
      const path = '/home/node/examples/' + file.path;
      assert.equal(fs.statSync(path).size, file.size);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex'), file.sha256);
      assert.equal(fs.statSync(path).mode & 0o222, 0);
    }
    for (const path of ['/home/node/LICENSE', '/home/node/EXAMPLES-README.md'])
      assert.equal(fs.statSync(path).mode & 0o222, 0);
    const inventory = JSON.parse(fs.readFileSync('/app/licenses/packages.json', 'utf8'));
    assert.equal(inventory.length, 29);
    for (const name of ['konva', 'mediabunny', 'hls.js', 'svelte', '@cfworker/json-schema', '@codemirror/language', '@lezer/common', 'workbox-core', 'workbox-precaching', 'workbox-routing', 'workbox-strategies', 'workbox-window', 'url-toolkit', 'eventemitter3', '@svta/cml-id3', '@svta/cml-utils']) assert(inventory.some(pkg => pkg.name === name), name);
    for (const pkg of inventory) {
      const root = '/app/licenses/' + pkg.name + '/' + pkg.version;
      for (const [file, digest] of Object.entries(pkg.notices)) {
        const bytes = fs.readFileSync(root + '/' + file);
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), digest);
        assert.deepEqual(fs.readFileSync('/app/web/licenses/' + pkg.name + '/' + pkg.version + '/' + file), bytes);
      }
      for (const [file, digest] of Object.entries(pkg.source || {})) {
        const bytes = fs.readFileSync(root + '/src/' + file);
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), digest);
        assert.deepEqual(fs.readFileSync('/app/web/licenses/' + pkg.name + '/' + pkg.version + '/src/' + file), bytes);
      }
    }
    assert.equal(Object.keys(inventory.find(pkg => pkg.name === 'mediabunny').source).length, 67);
    assert.match(fs.readFileSync('/app/licenses/konva/10.7.1/LICENSE', 'utf8'), /Eric Rowell/);
    assert.match(fs.readFileSync('/app/licenses/konva/10.7.1/LICENSE', 'utf8'), /Anton Lavrenov/);
    const blurFile = 'embedded/lib/filters/Blur.js';
    const blur = fs.readFileSync('/app/licenses/konva/10.7.1/' + blurFile, 'utf8');
    // Digest of the complete original file in the frozen Konva 10.7.1 package.
    assert.equal(crypto.createHash('sha256').update(blur).digest('hex'), '3044af7ab9c2a49db02e97a2cbc5dbef6b6ce6fba9e600b79c1520078e37e847');
    assert.match(blur, /Copyright \\(c\\) 2010 Mario Klingemann/);
    assert.match(blur, /Permission is hereby granted, free of charge/);
    assert.match(blur, /included in all copies or substantial portions of the Software/);
    assert.match(blur, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
    assert.match(blur, /OTHER DEALINGS IN THE SOFTWARE/);
    assert.equal(inventory.find(pkg => pkg.name === 'konva').notices[blurFile], crypto.createHash('sha256').update(blur).digest('hex'));
    assert.equal(fs.readFileSync('/app/web/licenses/konva/10.7.1/' + blurFile, 'utf8'), blur);
    for (const dir of ['/app/licenses', '/app/web/licenses']) assert(fs.readFileSync(dir + '/THIRD-PARTY-NOTICES.txt', 'utf8').includes(blur));
    assert(inventory.find(pkg => pkg.name === 'konva').notices['embedded/lib/Global.js']);
    assert(inventory.find(pkg => pkg.name === 'workbox-core').notices['embedded/_private/Deferred.js']);
    assert(inventory.find(pkg => pkg.name === 'workbox-routing').notices['embedded/Router.js']);
    assert.match(fs.readFileSync('/app/licenses/@cfworker/json-schema/4.1.1/LICENSE.md', 'utf8'), /2020 Jeremy Danyow/);
    assert.match(fs.readFileSync('/app/licenses/hls.js/1.7.3/LICENSE', 'utf8'), /Brightcove/);
    assert.match(fs.readFileSync('/app/licenses/url-toolkit/2.2.5/LICENSE', 'utf8'), /2016 Tom Jenkinson/);
    assert.match(fs.readFileSync('/app/licenses/eventemitter3/5.0.4/LICENSE', 'utf8'), /2014 Arnout Kazemier/);
    assert.match(fs.readFileSync('/app/licenses/@svta/cml-id3/1.0.6/NOTICE.md', 'utf8'), /2023/);
    assert.equal(inventory.filter(pkg => pkg.prebundledIn === 'hls.js@1.7.3').length, 4);
    assert.match(fs.readFileSync('/app/licenses/hls.js/1.7.3/Apache-2.0.txt', 'utf8'), /END OF TERMS AND CONDITIONS/);
    assert.match(fs.readFileSync('/app/licenses/THIRD-PARTY-NOTICES.txt', 'utf8'), /Source availability: mediabunny/);
    assert.match(fs.readFileSync('/app/web/index.html', 'utf8'), /rel="license"/);
    function noMaps(dir) { for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const path = dir + '/' + entry.name;
      if (entry.isDirectory()) noMaps(path);
      else assert(!entry.name.endsWith('.map'), path);
    }} noMaps('/app/web');
    require('playwright-core');
    async function startup(env, expected) {
      const {spawn} = require('node:child_process');
      const child = spawn('/app/docker-entrypoint.sh', [], {env: {...process.env, ...env}, stdio: ['ignore', 'inherit', 'inherit']});
      const exited = new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal}));});
      try {
        let listing;
        for (let i = 0; i < 100; i++) {
          try { const response = await fetch('http://127.0.0.1:4400/api/workspace'); if (response.ok) {listing = await response.json(); break;} } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert(listing, 'Default wrapper did not start workspace');
        assert.equal(listing.initial.name, expected);
        assert.deepEqual(listing.examples.map(example => example.name).sort(), ${JSON.stringify(EXAMPLE_NAMES)});
        assert(listing.examples.every(example => example.readOnly));
        const page = await fetch('http://127.0.0.1:4400' + listing.initial.url + 'licenses/THIRD-PARTY-NOTICES.txt');
        assert.equal(page.status, 200);
        assert((await page.text()).includes('Browser third-party notices'));
      } finally { child.kill('SIGTERM'); }
      const exit = await exited;
      assert.equal(exit.code, 0);
    }
    (async () => {
      await Promise.all([import('@storyboard-viewer/format'), import('@storyboard-viewer/format/node')]);
      await startup({SBD_NAME: ''}, 'midnight-snack.sbd');
      const {execFileSync} = require('node:child_process');
      execFileSync('/app/docker-entrypoint.sh', ['new', '/projects/explicit project.sbd', '--preset', 'blank']);
      await startup({SBD_NAME: 'explicit project.sbd'}, 'explicit project.sbd');
      console.log('Nonroot package, runtime imports, default workspace and quoted SBD_NAME verified');
    })().catch(error => {console.error(error); process.exitCode = 1;});
  `;
    assert.equal(
      run(['--entrypoint', 'node', tag, '-e', probe], 'runtime-package').status,
      0,
      `Runtime package failed; see ${logs}`,
    );
    assert.equal(run([tag, '--help'], 'cli-help').status, 0, 'CLI cannot start offline');

    assert.equal(run([tag, '--version'], 'cli-version').status, 0);
    if (prebuilt) {
      console.log(`Prebuilt runtime checks passed. Build-injection checks not run. Logs: ${logs}`);
      return;
    }

    const mismatch = context('lock-mismatch');
    const manifest = JSON.parse(readFileSync(join(mismatch, 'packages/cli/package.json'), 'utf8'));
    manifest.dependencies.zod = '0.0.0';
    writeFileSync(join(mismatch, 'packages/cli/package.json'), JSON.stringify(manifest));
    const locked = build(mismatch, 'lock-mismatch');
    assert.notEqual(locked.status, 0);
    assert.match(locked.stdout + locked.stderr, /ERR_PNPM_OUTDATED_LOCKFILE/);

    const compile = context('compile-error');
    writeFileSync(
      join(compile, 'packages/cli/src/image-build-failure.ts'),
      'const impossible: never = 1;\n',
    );
    const compiled = build(compile, 'compile-error');
    assert.notEqual(compiled.status, 0);
    assert.match(compiled.stdout + compiled.stderr, /image-build-failure.ts.*error TS/);

    const incomplete = context('incomplete-output');
    const copy = join(incomplete, 'packages/cli/scripts/copy-web.mjs');
    writeFileSync(copy, readFileSync(copy, 'utf8') + "\nrmSync(join(dest, 'sw.js'));\n");
    const missing = build(incomplete, 'incomplete-output');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /CLI web copy is incomplete/);
    assert.equal(
      readFileSync(join(clean, 'pnpm-lock.yaml'), 'utf8'),
      readFileSync(join(repository, 'pnpm-lock.yaml'), 'utf8'),
    );

    // A poisoned host installation/output must not enter the build context.
    for (const path of [
      'node_modules/poison',
      'packages/cli/dist/cli.js',
      'packages/cli/web/index.html',
      'apps/web/dist/index.html',
    ]) {
      mkdirSync(join(clean, path, '..'), { recursive: true });
      writeFileSync(join(clean, path), 'HOST OUTPUT MUST NOT BE USED');
    }
    assert.equal(build(clean, 'ignored-host-output').status, 0, 'Host output was not excluded');
    // Delete only source copies positively created by this test. Keep evidence logs.
    for (const name of ['clean', 'lock-mismatch', 'compile-error', 'incomplete-output'])
      rmSync(join(root, name), { recursive: true });
    console.log(
      `Packaging checks passed. Logs retained at ${logs}; task-created image ${tag} retained.`,
    );
  },
);
