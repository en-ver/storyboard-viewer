// Ordinary pnpm test needs no Docker. Opt in to config resolution with:
// SBD_COMPOSE_TESTS=1 node --test scripts/test/compose.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/yaml';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const developer = readFileSync(join(repository, 'docker-compose.yml'), 'utf8');
const consumer = readFileSync(join(repository, 'docker-compose.template.yml'), 'utf8');

function standalone(text, prefix, port) {
  parsers.yaml.parse(text);
  assert.deepEqual(
    [...text.matchAll(/^  (\w+):$/gm)].map((m) => m[1]),
    ['viewer'],
  );
  assert.match(text, /    init: true\n/);
  assert.match(text, /    user: '\$\{SBD_UID:-1000\}:\$\{SBD_GID:-1000\}'/);
  assert.match(
    text,
    /command: \['serve', '\/storyboard.sbd', '--host', '0.0.0.0', '--port', '4400'\]/,
  );
  assert.match(text, /SBD_CONFIG_DIR: \/config\n      HOME: \/tmp/);
  assert.match(text, /    read_only: true\n    cap_drop: \[ALL\]/);
  assert.match(text, /    security_opt: \[no-new-privileges:true\]/);
  assert.match(text, /    restart: 'no'\n    stop_grace_period: 10s/);
  assert.ok(text.includes(`'127.0.0.1:\${SBD_PORT:-${port}}:4400'`));
  assert.deepEqual(
    [...text.matchAll(/        source: (.+)\n        target: (.+)/g)].map((m) => [m[1], m[2]]),
    ['storyboard.sbd', 'config', 'tmp'].map((p) => [`./${prefix}${p}`, `/${p}`]),
  );
  assert.equal([...text.matchAll(/      - type: bind/g)].length, 3);
  assert.equal([...text.matchAll(/          create_host_path: false/g)].length, 3);
  assert.doesNotMatch(text, /^\s*(extends|include|env_file|tmpfs):/m);
}

test('standalone developer file builds native source with three local development binds', () => {
  standalone(developer, '.dev/', 4410);
  assert.match(developer, /image: storyboard-viewer:dev/);
  assert.match(developer, /    build:\n      context: \.\n      dockerfile: Dockerfile/);
  assert.match(developer, /    pull_policy: build/);
  assert.doesNotMatch(developer, /platform:|SBD_IMAGE/);
});

test('standalone consumer file selects a host-native image with three portable relative binds', () => {
  standalone(consumer, '', 4400);
  assert.match(
    consumer,
    /image: \$\{SBD_IMAGE:\?Set SBD_IMAGE to a full published image reference\}/,
  );
  assert.match(consumer, /    pull_policy: missing/);
  assert.doesNotMatch(consumer, /^\s*(platform|build|context|dockerfile):/m);
});

test(
  'ordinary standalone configurations resolve through Compose (opt in)',
  {
    skip: process.env['SBD_COMPOSE_TESTS'] !== '1',
    timeout: 60_000,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'sbd-compose-config-'));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('COMPOSE_') || key.startsWith('SBD_')) delete env[key];
    }
    // A selected mock digest is configuration data only. This test never pulls or starts it.
    const image = `ghcr.io/example-owner/example-repository@sha256:${'a'.repeat(64)}`;
    function config(cwd, file, selectedImage) {
      return JSON.parse(
        execFileSync(
          'docker',
          [
            'compose',
            '--env-file',
            '/dev/null',
            '--project-name',
            'sbd-compose-config',
            ...(file ? ['--file', file] : []),
            'config',
            '--format',
            'json',
          ],
          {
            cwd,
            env: { ...env, ...(selectedImage ? { SBD_IMAGE: selectedImage } : {}) },
            encoding: 'utf8',
            timeout: 20_000,
          },
        ),
      );
    }
    function runtime(c, dir, prefix, port) {
      assert.deepEqual(Object.keys(c.services), ['viewer']);
      const v = c.services.viewer;
      assert.equal(v.user, '1000:1000');
      assert.equal(v.init, true);
      assert.equal(v.read_only, true);
      assert.deepEqual(v.cap_drop, ['ALL']);
      assert.deepEqual(v.security_opt, ['no-new-privileges:true']);
      assert.equal(v.restart, 'no');
      assert.equal(v.stop_grace_period, '10s');
      assert.equal(v.environment.HOME, '/tmp');
      assert.equal(v.environment.SBD_CONFIG_DIR, '/config');
      assert.deepEqual(v.command, [
        'serve',
        '/storyboard.sbd',
        '--host',
        '0.0.0.0',
        '--port',
        '4400',
      ]);
      assert.equal(v.ports[0].host_ip, '127.0.0.1');
      assert.equal(v.ports[0].published, String(port));
      assert.equal(v.ports[0].target, 4400);
      assert.deepEqual(
        v.volumes.map((b) => [b.type, b.source, b.target, b.bind.create_host_path]),
        ['storyboard.sbd', 'config', 'tmp'].map((p) => [
          'bind',
          resolve(dir, prefix, p),
          `/${p}`,
          false,
        ]),
      );
      return v;
    }
    try {
      const explicit = config(repository, 'docker-compose.yml');
      assert.deepEqual(config(repository), explicit);
      const dev = runtime(explicit, repository, '.dev', 4410);
      assert.equal(dev.image, 'storyboard-viewer:dev');
      assert.equal(dev.pull_policy, 'build');
      assert.equal(dev.build.context, resolve(repository));
      assert.equal(dev.build.dockerfile, 'Dockerfile');
      assert.equal(dev.platform, undefined);
      copyFileSync(
        join(repository, 'docker-compose.template.yml'),
        join(root, 'docker-compose.yml'),
      );
      for (const p of ['storyboard.sbd', 'config', 'tmp']) mkdirSync(join(root, p));
      const used = runtime(config(root, undefined, image), root, '', 4400);
      assert.equal(used.image, image);
      assert.equal(used.platform, undefined);
      assert.equal(used.pull_policy, 'missing');
      assert.equal(used.build, undefined);
    } finally {
      rmSync(root, { recursive: true });
    }
  },
);
