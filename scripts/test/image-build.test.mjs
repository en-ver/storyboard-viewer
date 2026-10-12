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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const enabled = process.env['SBD_DOCKER_TESTS'] === '1';

test(
  'image build and rejection guards (requires Docker)',
  { skip: !enabled, timeout: 600_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'sbd-image-build-'));
    const logs = join(root, 'logs');
    mkdirSync(logs);
    const tag = `storyboard-viewer-test:${basename(root).toLowerCase()}`;
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
    assert.equal(docker(['info'], 'readiness').status, 0, 'Docker is not ready');
    assert.notEqual(
      docker(['image', 'inspect', tag], 'tag-collision').status,
      0,
      'Test tag already exists',
    );
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
    const clean = context('clean');
    assert.equal(build(clean, 'clean-build').status, 0, `Clean Git-free build failed; see ${logs}`);
    const image = docker(['image', 'inspect', tag], 'image');
    assert.equal(image.status, 0);
    const info = JSON.parse(image.stdout)[0];
    assert.equal(info.Config.User, 'node');
    assert.deepEqual(info.Config.Entrypoint, ['node', '/app/dist/cli.js']);
    console.log(`Git-free image: ${info.Id}`);
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
    for (const path of ['/app/dist/cli.js', '/app/LICENSE', '/app/licenses/@fontsource/montserrat/LICENSE', '/app/web/index.html', '/app/web/sw.js']) assert(fs.statSync(path).isFile(), path);
    require('playwright-core');
    Promise.all([import('@storyboard-viewer/format'), import('@storyboard-viewer/format/node')]).then(() => console.log('Nonroot, read-only package and runtime imports verified'));
  `;
    assert.equal(
      docker(
        ['run', '--rm', '--network', 'none', '--entrypoint', 'node', tag, '-e', probe],
        'runtime-package',
      ).status,
      0,
      `Runtime package failed; see ${logs}`,
    );
    assert.equal(
      docker(['run', '--rm', '--network', 'none', tag, '--help'], 'cli-help').status,
      0,
      'CLI cannot start offline',
    );

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
