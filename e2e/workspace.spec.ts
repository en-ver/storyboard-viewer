// One normal workspace flow, with an owned listener and fixtures from the current build.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
let fixture: string;
let server: ChildProcess;
let url: string;

async function start(): Promise<string> {
  const child = spawn(
    process.execPath,
    [
      join(root, 'packages/cli/dist/cli.js'),
      'serve',
      '--workspace',
      join(fixture, 'projects'),
      '--examples',
      join(fixture, 'examples'),
      '--port',
      '0',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: root,
      env: { ...process.env, SBD_CONFIG_DIR: join(fixture, 'config') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server = child;
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`Workspace startup timed out: ${output}`)),
      10_000,
    );
    child.stdout!.on('data', (data: Buffer) => {
      output += data.toString();
      const found = /Storyboard Viewer: http:\/\/localhost:(\d+)\//.exec(output);
      if (found) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${found[1]}/`);
      }
    });
    child.stderr!.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Workspace exited ${code}: ${output}`));
    });
  });
}
async function stop() {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
}

test.beforeAll(async () => {
  fixture = mkdtempSync(join(tmpdir(), 'workspace-ui-'));
  mkdirSync(join(fixture, 'projects'));
  cpSync(join(root, 'examples'), join(fixture, 'examples'), { recursive: true });
  cpSync(join(root, 'LICENSE'), join(fixture, 'LICENSE'));
  url = await start();
});
test.afterAll(stop);

test('workspace: examples, copy, edit, new, switch, rename and persistent selection on one port', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem('sbd:tour-offered', '1'));
  // Simulate an existing cached legacy shell on the live workspace listener.
  // The generic serve marker remains, but mode and selection cannot come from HTML.
  await page.route(url, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /<meta\s+name="sbd-(?:workspace|base)"[^>]*>/g,
      '',
    );
    await route.fulfill({ response, body });
  });
  await page.goto(url);
  const exampleTitle = JSON.parse(
    readFileSync(join(fixture, 'examples/midnight-snack.sbd/manifest.json'), 'utf8'),
  ).title as string;
  await expect(page.locator('#project-title')).toHaveText(exampleTitle);
  const initial = await (await page.request.get(`${url}api/workspace`)).json();
  expect(initial.initial.readOnly).toBe(true);
  expect(initial.examples).toHaveLength(6);
  expect(readdirSync(join(fixture, 'projects'))).toEqual([]);
  await expect(page.locator('[data-tour="script"] .cm-content')).toHaveAttribute(
    'contenteditable',
    'false',
  );
  await page.locator('#file-menu').click();
  await page.getByRole('menuitem', { name: 'Open workspace storyboard…' }).click();
  await expect(page.locator('[data-workspace-group="examples"] li')).toHaveCount(6);
  await expect(page.locator('[data-workspace-group="projects"]')).toContainText('No projects yet.');
  await page.getByRole('button', { name: `Copy ${exampleTitle} to Projects` }).click();
  await page.locator('#workspace-name').fill('test-copy');
  await page.locator('#workspace-confirm').click();
  await expect(page.locator('#workspace-selector')).toHaveText('Projects / test-copy.sbd');
  const copy = join(fixture, 'projects/test-copy.sbd');
  expect(readFileSync(join(copy, 'ids.json'))).toEqual(
    readFileSync(join(fixture, 'examples/midnight-snack.sbd/ids.json')),
  );
  expect(existsSync(join(copy, 'LICENSE'))).toBe(true);
  expect(existsSync(join(copy, 'EXAMPLES-README.md'))).toBe(true);
  await page.locator('#file-menu').click();
  await page.getByRole('menuitem', { name: 'Project settings…' }).click();
  await page.locator('#settings-title-input').fill('Test Data');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('Saved');
  expect(JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')).title).toBe('Test Data');

  await page.locator('#workspace-selector').focus();
  await page.keyboard.press('Enter');
  await page.locator('#workspace-new').click();
  await expect(page.locator('[data-preset="blank"] input')).toBeChecked();
  await page.locator('#new-name').fill('test-blank');
  await page.locator('#new-title').fill('Blank Test Data');
  const beforeNew = page.url();
  await page.locator('#new-create').click();
  // Capture the address at the first visible ready selection, not after a URL wait.
  const newReadyUrl = await page.waitForFunction(() => {
    if (
      document.querySelector('#workspace-selector')?.textContent?.trim() !==
      'Projects / test-blank.sbd'
    )
      return null;
    return location.href;
  });
  const blankUrl = (await newReadyUrl.jsonValue()) as string;
  expect(blankUrl).not.toBe(beforeNew);
  expect(new URL(blankUrl).pathname).toMatch(/^\/p\/[a-f0-9]{48}\/$/);
  await expect(page.locator('#workspace-selector')).toHaveText('Projects / test-blank.sbd');
  const blank = JSON.parse(readFileSync(join(fixture, 'projects/test-blank.sbd/ids.json'), 'utf8'));
  expect(blank.lines).toHaveLength(0);
  expect(blank.shots).toHaveLength(0);
  const otherTab = await page.context().newPage();
  await otherTab.goto(page.url());
  await expect(otherTab.locator('#project-title')).toHaveText('Blank Test Data');
  await page.locator('#file-menu').click();
  await page.getByRole('menuitem', { name: 'Recent workspace storyboards…' }).click();
  await page
    .locator('section[aria-labelledby="workspace-recent-title"]')
    .getByRole('button', { name: /\btest-copy\.sbd\b/ })
    .click();
  await expect(page.locator('#project-title')).toHaveText('Test Data');
  await page.reload();
  await expect(page.locator('#project-title')).toHaveText('Test Data');
  await page.locator('#workspace-selector').click();
  await page.getByRole('button', { name: 'Rename folder…' }).click();
  await page.locator('#workspace-name').fill('test-renamed');
  await page
    .getByRole('checkbox', { name: 'Other writers are paused, including MCP sessions.' })
    .check();
  await page.locator('#workspace-confirm').click();
  await expect(page.locator('#workspace-selector')).toHaveText('Projects / test-renamed.sbd');
  // A user can reload as soon as Rename is visible. Do not wait for a later URL update.
  await page.reload();
  await expect(page.locator('#workspace-selector')).toHaveText('Projects / test-renamed.sbd');
  await expect(page.locator('#project-title')).toHaveText('Test Data');
  expect(existsSync(copy)).toBe(false);
  expect(existsSync(join(fixture, 'projects/test-renamed.sbd'))).toBe(true);
  expect(new URL(page.url()).origin).toBe(new URL(url).origin);
  expect(new URL(page.url()).pathname).toMatch(/^\/p\/[a-f0-9]{48}\/$/);
  await expect(otherTab.locator('#project-title')).toHaveText('Blank Test Data');
  await expect(otherTab.locator('#workspace-selector')).toHaveText('Projects / test-blank.sbd');
  await otherTab.close();
  await stop();
  url = await start();
  await page.goto(url);
  await expect(page.locator('#project-title')).toHaveText('Test Data');
  await expect(page.locator('#workspace-selector')).toHaveText('Projects / test-renamed.sbd');
  const restored = await (await page.request.get(`${url}api/workspace`)).json();
  expect(restored.initial.name).toBe('test-renamed.sbd');
  expect(restored.recent[0].path).toBe(join(fixture, 'projects/test-renamed.sbd'));
});
