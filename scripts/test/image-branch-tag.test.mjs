import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/yaml';
import { imageBranchTag } from '../image-branch-tag.mjs';

const helper = fileURLToPath(new URL('../image-branch-tag.mjs', import.meta.url));
const workflow = readFileSync(
  new URL('../../.github/workflows/publish-image.yml', import.meta.url),
  'utf8',
);

test('ordinary main and feature branches produce the workflow output', () => {
  assert.equal(imageBranchTag('main'), 'branch-main');
  assert.equal(imageBranchTag('feature/docker'), 'branch-feature-docker');
  const dir = mkdtempSync(join(tmpdir(), 'sbd-branch-tag-'));
  try {
    const output = join(dir, 'output');
    execFileSync(process.execPath, [helper], {
      env: { ...process.env, GITHUB_REF_NAME: 'feature/docker', GITHUB_OUTPUT: output },
    });
    assert.equal(readFileSync(output, 'utf8'), 'tag=branch-feature-docker\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publication uses bounded branch/full-SHA tags and the pinned default-branch latest helper', () => {
  // Parse the actual YAML with the existing formatter dependency. The assertions below target
  // this workflow's fixed structure, not a simulated hosted action or a detached tag example.
  parsers.yaml.parse(workflow);
  assert.match(workflow, /\non:\n  push:\n    branches: \['\*\*'\]\n  workflow_dispatch:\n/);
  assert.match(workflow, /\npermissions: \{\}\n\njobs:\n  publish:\n/);
  assert.match(
    workflow,
    /    runs-on: ubuntu-24\.04\n    timeout-minutes: 45\n    permissions:\n      contents: read\n      packages: write\n/,
  );
  const guard = workflow
    .match(/    if: >-\n([\s\S]*?)    runs-on:/)[1]
    .replace(/\s+/g, ' ')
    .trim();
  assert.equal(
    guard,
    "${{ (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref_type == 'branch' && startsWith(github.ref, 'refs/heads/') && github.event.deleted != true }}",
  );
  assert.deepEqual(
    [...workflow.matchAll(/^        uses: (\S+)/gm)].map((m) => m[1]),
    [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069',
      'docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302',
      'docker/login-action@dbcb813823bdd20940b903addbd779551569679f',
      'docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc',
    ],
  );
  const steps = workflow.split(/^      - name: /m).slice(1);
  const step = (id) => {
    const matches = steps.filter((s) => s.includes(`\n        id: ${id}\n`));
    assert.equal(matches.length, 1);
    return matches[0];
  };
  assert.match(
    steps[0],
    /          ref: \$\{\{ github.sha \}\}\n          persist-credentials: false/,
  );
  assert.match(step('branch'), /        run: node scripts\/image-branch-tag.mjs\n/);
  assert.ok(steps.indexOf(step('branch')) < steps.indexOf(step('meta')));
  const meta = step('meta');
  assert.match(meta, /          images: ghcr.io\/\$\{\{ github.repository \}\}/);
  assert.equal(
    meta.match(/          flavor: \|\n([\s\S]*?)          tags:/)[1].trim(),
    'latest=false',
  );
  assert.deepEqual(
    meta
      .match(/          tags: \|\n([\s\S]*?)          labels:/)[1]
      .trim()
      .split(/\n\s*/),
    [
      'type=raw,value=${{ steps.branch.outputs.tag }}',
      'type=sha,format=long,prefix=sha-',
      'type=raw,value=latest,enable={{is_default_branch}}',
    ],
  );
  // The pinned helper enables raw latest on ordinary default main, not on feature/docker.
  // Its case-sensitive semantics were inspected in the pinned source; this is static evidence.
  assert.deepEqual(
    meta
      .match(/          labels: \|\n([\s\S]*)/)[1]
      .trim()
      .split(/\n\s*/),
    [
      'org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}',
      'org.opencontainers.image.url=${{ github.server_url }}/${{ github.repository }}',
      'org.opencontainers.image.revision=${{ github.sha }}',
    ],
  );
  assert.match(
    steps[4],
    /          registry: ghcr.io\n          username: \$\{\{ github.actor \}\}\n          password: \$\{\{ secrets.GITHUB_TOKEN \}\}/,
  );
  assert.match(
    steps[5],
    /          builder: \$\{\{ steps.buildx.outputs.name \}\}\n          context: \.\n          file: \.\/Dockerfile\n          platforms: linux\/amd64\n          push: true\n          tags: \$\{\{ steps.meta.outputs.tags \}\}\n          labels: \$\{\{ steps.meta.outputs.labels \}\}/,
  );
});
