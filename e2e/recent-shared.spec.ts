// Shared recent storyboards across `sbd serve` ports: browser storage is per origin, so the
// servers keep one list in the config folder (SBD_CONFIG_DIR here, a temp folder).
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CLI, EXAMPLE, ROOT } from './helpers.js';

const TMP = join(ROOT, 'e2e/.tmp/shared-recent');
const CONFIG = join(TMP, 'config');
const PORT_A = Number(process.env['E2E_PORT'] ?? 4471) + 10;
const PORT_B = PORT_A + 10;
const children: ChildProcess[] = [];

function copy(name: string, title: string): string {
  const dir = join(TMP, `${name}.sbd`);
  cpSync(EXAMPLE, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.title = title;
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  return dir;
}

async function serve(path: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [CLI, 'serve', path, '--port', String(port)], {
    env: { ...process.env, SBD_CONFIG_DIR: CONFIG },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on(
      'data',
      (d: Buffer) => d.toString().includes('Storyboard Viewer:') && resolve(),
    );
    child.on('exit', (c) => reject(new Error(`sbd serve exited (${c})`)));
  });
  return child;
}

const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});
test.afterAll(async () => {
  await Promise.all(children.map(stop));
  rmSync(TMP, { recursive: true, force: true });
});

test('recent storyboards are shared between ports and reopen from any of them', async ({
  page,
}) => {
  const a = copy('alpha', 'Alpha Story');
  const b = copy('beta', 'Beta Story');
  const srvA = await serve(a, PORT_A);
  await serve(b, PORT_B);
  const A = `http://localhost:${PORT_A}`;
  const B = `http://localhost:${PORT_B}`;

  // The app sends its thumbnail once the first picture has decoded, after the page is shown;
  // leaving A before that would cancel it (a slow CI runner showed this).
  const thumbSent = page.waitForResponse(
    (r) => r.url() === `${A}/api/recent/thumbnail` && r.request().method() === 'PUT',
  );
  await page.goto(`${A}/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Alpha Story');
  expect((await thumbSent).ok()).toBe(true);
  await page.goto(`${B}/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Beta Story');

  // the start screen on B lists what was opened on A (another origin) too
  await page.goto(`${B}/?source=local`);
  const items = page.locator('#recent-list li[data-recent]');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAttribute('data-recent', `served:${b}`);
  const alpha = page.locator(`#recent-list li[data-recent="served:${a}"]`);
  await expect(alpha).toContainText('Alpha Story');
  await expect(alpha.locator('img')).toBeVisible(); // thumbnail sent by the app on A

  // A is running: reopening goes to its server
  await alpha.getByRole('button', { name: /^Open Alpha Story/ }).click();
  await expect(page).toHaveURL(`${A}/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Alpha Story');

  // A stopped: B starts a viewer for it on the next free port
  await stop(srvA);
  await page.goto(`${B}/?source=local`);
  await page
    .locator(`#recent-list li[data-recent="served:${a}"]`)
    .getByRole('button', { name: /^Open Alpha Story/ })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Alpha Story');
  const url = new URL(page.url());
  expect(Number(url.port)).toBeGreaterThan(PORT_B);

  // the list lives in the config folder
  const file = JSON.parse(readFileSync(join(CONFIG, 'recent.json'), 'utf8'));
  expect(file.recent.map((e: { path: string }) => e.path).toSorted()).toEqual([a, b].toSorted());

  // remove one, clear: shared by every port
  await page.goto(`${B}/?source=local`);
  await page
    .locator(`#recent-list li[data-recent="served:${b}"]`)
    .getByRole('button', { name: /^Remove/ })
    .click();
  await expect(page.locator(`#recent-list li[data-recent="served:${b}"]`)).toHaveCount(0);
  await page.locator('#clear-recent').click();
  await expect(page.locator('#recent-list')).toHaveCount(0);
  expect(JSON.parse(readFileSync(join(CONFIG, 'recent.json'), 'utf8')).recent).toEqual([]);
});

test('save and reopen the current recent storyboard at the browser origin', async ({ page }) => {
  const story = copy('current', 'Current Story');
  const base = `http://localhost:${PORT_B + 6}`;
  await serve(story, PORT_B + 6);
  await page.goto(`${base}/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Current Story');

  await page.locator('#view-menu').click();
  await page.locator('[data-command="view-board"]').click();
  await page.locator('[data-shot-id="climb"] .select').click();
  await page.locator('#shot-title-input').fill('Saved current shot');
  await page.locator('#shot-title-input').press('Tab');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  expect(JSON.parse(readFileSync(join(story, 'shots/climb.json'), 'utf8')).title).toBe(
    'Saved current shot',
  );

  // A container advertises its internal origin. Keep the real response's current marker,
  // but replace its absolute URL to demonstrate reopening without navigating to that host.
  await page.route(`${base}/api/open`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    expect(body).toEqual({ url: `${base}/`, current: true });
    await route.fulfill({
      response,
      json: { ...body, url: 'http://viewer:4400/' },
    });
  });
  await page.goto(`${base}/?source=local`);
  await page
    .locator(`#recent-list li[data-recent="served:${story}"]`)
    .getByRole('button', { name: /^Open Current Story/ })
    .click();
  await expect(page).toHaveURL(`${base}/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Current Story');
  await expect(page.locator('[data-shot-id="climb"]')).toContainText('Saved current shot');
});

test('/api/open only opens storyboards from the recent list', async ({ request }) => {
  const c = copy('gamma', 'Gamma');
  await serve(c, PORT_B + 5);
  const res = await request.post(`http://localhost:${PORT_B + 5}/api/open`, {
    headers: { 'x-sbd-client': 'e2e' },
    data: { path: '/etc' },
  });
  expect(res.status()).toBe(403);
});
