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
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, run } from '../src/index.js';
import { VERSION } from '../src/version.js';
import { EXAMPLE, PKG, ROOT } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sbd-cli-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sbd', () => {
  it('prints help listing every command', async () => {
    const c = capture();
    expect(await run([], c.io)).toBe(0);
    for (const cmd of COMMANDS) expect(c.out.join('\n')).toContain(cmd.name);
  });

  it('prints the version (in sync with package.json)', async () => {
    const c = capture();
    expect(await run(['--version'], c.io)).toBe(0);
    expect(c.out).toEqual([VERSION]);
    expect(JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version).toBe(VERSION);
  });

  it('rejects unknown commands and bad options', async () => {
    const c = capture();
    expect(await run(['frobnicate'], c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/Unknown command/);
    const d = capture();
    expect(await run(['new', join(tmp(), 'x.sbd'), '--preset', 'opera'], d.io)).toBe(2);
    expect(d.err.join('\n')).toMatch(/Unknown preset "opera"/);
    const e = capture();
    expect(await run(['validate', '--nope'], e.io)).toBe(2);
  });

  it('shows per-command help', async () => {
    const c = capture();
    expect(await run(['pack', '--help'], c.io)).toBe(0);
    expect(c.out.join('\n')).toMatch(/Usage: sbd pack/);
  });

  it('shows both legacy and opt-in workspace serve usage', async () => {
    const c = capture();
    expect(await run(['serve', '--help'], c.io)).toBe(0);
    const help = c.out.join('\n');
    expect(help).toContain('serve <path>');
    for (const flag of ['--workspace', '--examples', '--default-project'])
      expect(help).toContain(flag);
  });

  it('creates and validates a new storyboard', async () => {
    const dir = join(tmp(), 'brand.sbd');
    const c = capture();
    expect(
      await run(['new', dir, '--preset', 'motion', '--aspect', '9:16', '--title', 'Launch'], c.io),
    ).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      title: 'Launch',
      preset: 'motion',
      aspect_ratio: '9:16',
      canvas: { width: 1080, height: 1920 },
    });
    expect(existsSync(join(dir, 'media'))).toBe(true);
    const v = capture();
    expect(await run(['validate', dir], v.io)).toBe(0);
    expect(v.out.join('\n')).toMatch(/^Valid: 0 shots/m);
    const again = capture();
    expect(await run(['new', dir], again.io)).toBe(1);
    expect(again.err.join('\n')).toMatch(/not empty/);
  });

  it('validates with exit code 1 on errors and --json output', async () => {
    const dir = join(tmp(), 'story.sbd');
    cpSync(EXAMPLE, dir, { recursive: true });
    rmSync(join(dir, 'media/maya.png'));
    const c = capture();
    expect(await run(['validate', dir], c.io)).toBe(1);
    expect(c.out.join('\n')).toMatch(/missing from the package/);
    const j = capture();
    expect(await run(['validate', dir, '--json'], j.io)).toBe(1);
    expect(JSON.parse(j.out.join('\n')).valid).toBe(false);
  });

  it('packs and unpacks round-trip', async () => {
    const work = tmp();
    const dir = join(work, 'minimal.sbd');
    cpSync(EXAMPLE, dir, { recursive: true });
    const p = capture();
    expect(await run(['pack', dir], p.io)).toBe(0);
    const packed = join(work, 'minimal-packed.sbd');
    expect(existsSync(packed)).toBe(true);
    expect(readFileSync(packed).subarray(30, 38).toString()).toBe('mimetype');
    const v = capture();
    expect(await run(['validate', packed], v.io)).toBe(0);
    const u = capture();
    expect(await run(['unpack', packed, '-o', join(work, 'out.sbd')], u.io)).toBe(0);
    for (const f of [
      'manifest.json',
      'ids.json',
      'script.fountain',
      'media/dialogue.wav',
      'shots/climb.json',
    ]) {
      expect(readFileSync(join(work, 'out.sbd', f))).toEqual(readFileSync(join(EXAMPLE, f)));
    }
  });

  it('imports and exports Fountain', async () => {
    const work = tmp();
    const script = join(work, 'short.fountain');
    writeFileSync(script, 'Title: Short\n\nINT. ROOM - DAY\n\nA lamp hums.\n\nBOB\nHello?\n');
    const c = capture();
    expect(await run(['import-fountain', script, '--preset', 'film'], c.io)).toBe(0);
    expect(c.out.join('\n')).toMatch(/3 script lines in 2 shots/);
    const dir = join(work, 'short.sbd');
    const v = capture();
    expect(await run(['validate', dir], v.io)).toBe(0);
    const e = capture();
    expect(await run(['export-fountain', dir], e.io)).toBe(0);
    expect(e.out.join('\n')).toBe('Title: Short\n\nINT. ROOM - DAY\n\nA lamp hums.\n\nBOB\nHello?');
  });

  it('imports a Storyboarder scene', async () => {
    const work = tmp();
    const src = join(ROOT, 'packages/format/test/fixtures/storyboarder/lantern');
    cpSync(src, join(work, 'lantern'), { recursive: true });
    const c = capture();
    expect(
      await run(['import-storyboarder', join(work, 'lantern/lantern.storyboarder')], c.io),
    ).toBe(0);
    expect(c.out.join('\n')).toMatch(/3 shots, 4 script lines, 8 assets/);
    expect(c.err.join('\n')).toMatch(/pencil\.png is missing/);
    const dir = join(work, 'lantern/lantern.sbd');
    expect(existsSync(join(dir, 'media/board-2-D3E4F.png'))).toBe(true);
    expect(existsSync(join(dir, 'media/board-1-A1B2C-thumbnail.png'))).toBe(false);
    const v = capture();
    expect(await run(['validate', dir], v.io)).toBe(0);
    const g = capture();
    expect(await run(['clean', dir], g.io)).toBe(0);
    expect(g.out).toEqual(['No unused media files.']);
  });

  it('lists and deletes unused media with clean', async () => {
    const work = tmp();
    const dir = join(work, 'story.sbd');
    cpSync(EXAMPLE, dir, { recursive: true });
    mkdirSync(join(dir, 'media/old'), { recursive: true });
    writeFileSync(join(dir, 'media/old/take-1.wav'), 'x'.repeat(2048));
    writeFileSync(join(dir, 'media/unused.png'), 'png');
    writeFileSync(join(dir, 'notes.txt'), 'not media');
    const dry = capture();
    expect(await run(['clean', dir], dry.io)).toBe(0);
    expect(dry.out.join('\n')).toMatch(/media\/old\/take-1\.wav[\s\S]*media\/unused\.png/);
    expect(dry.out.at(-1)).toMatch(/2 unused files .* --yes/);
    expect(existsSync(join(dir, 'media/unused.png'))).toBe(true);
    const yes = capture();
    expect(await run(['clean', dir, '--yes'], yes.io)).toBe(0);
    expect(existsSync(join(dir, 'media/unused.png'))).toBe(false);
    expect(existsSync(join(dir, 'media/old'))).toBe(false);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, 'media/dialogue.wav'))).toBe(true);
    const v = capture();
    expect(await run(['validate', dir], v.io)).toBe(0);
  });
});
