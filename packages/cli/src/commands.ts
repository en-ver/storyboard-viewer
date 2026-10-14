import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  exportFountain,
  formatIssues,
  hasErrors,
  isPresetId,
  PRESET_IDS,
  SBD_MIMETYPE,
  type PresetId,
  type ShotSplit,
} from '@storyboard-viewer/format';
import { openProjectPath } from '@storyboard-viewer/format/node';
import {
  createStoryboard,
  defaultOutput,
  findUnusedMedia,
  importFountainFile,
  importStoryboarderFile,
  removeMediaFiles,
  packFolder,
  unpackFile,
  writeText,
} from './project-files.js';
import { exportPdf } from './export-pdf.js';
import { startServer } from './server.js';
import { startWorkspaceServer } from './workspace-server.js';
import { ProjectStore } from './store.js';
import { VERSION } from './version.js';

export { VERSION };

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

interface Command {
  name: string;
  usage: string;
  summary: string;
  details?: string;
  options?: ParseArgsConfig['options'];
  run(args: { positionals: string[]; values: Record<string, unknown> }, io: Io): Promise<number>;
}

class UsageError extends Error {}

function presetOption(v: unknown): PresetId | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !isPresetId(v)) {
    throw new UsageError(`Unknown preset "${String(v)}". Choose one of: ${PRESET_IDS.join(', ')}`);
  }
  return v;
}

function need(positionals: string[], i: number, what: string): string {
  const v = positionals[i];
  if (!v) throw new UsageError(`Missing ${what}`);
  return v;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}

/** Keeps the process alive until SIGINT/SIGTERM, then runs `cleanup`. */
function untilSignal(cleanup: () => Promise<void>): Promise<number> {
  return new Promise((resolveExit) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      cleanup().finally(() => resolveExit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'new',
    usage:
      'sbd new <path> [--preset blank|film|documentary|animation|motion|vertical] [--title T] [--aspect 16:9]',
    summary: 'Create a new unpacked storyboard folder',
    options: { preset: { type: 'string' }, title: { type: 'string' }, aspect: { type: 'string' } },
    async run({ positionals, values }, io) {
      const dir = resolve(need(positionals, 0, '<path>'));
      const preset = presetOption(values['preset']);
      const title =
        (values['title'] as string | undefined) ??
        (dir.split(/[/\\]/).pop() ?? 'Untitled').replace(/\.sbd$/, '');
      await createStoryboard(dir, {
        title,
        ...(preset ? { preset } : {}),
        ...(values['aspect'] ? { aspect_ratio: values['aspect'] as string } : {}),
      });
      io.out(`Created ${dir} (${preset ?? 'blank'} preset)`);
      io.out(`Next: sbd serve "${dir}"`);
      return 0;
    },
  },
  {
    name: 'validate',
    usage: 'sbd validate <path> [--json] [--strict]',
    summary: 'Check a storyboard (folder or .sbd file)',
    details: 'Exit code 1 when there are errors (or warnings with --strict).',
    options: { json: { type: 'boolean' }, strict: { type: 'boolean' } },
    async run({ positionals, values }, io) {
      const path = need(positionals, 0, '<path>');
      const opened = await openProjectPath(path);
      await opened.close();
      const { issues } = opened;
      const bad =
        hasErrors(issues) ||
        (values['strict'] === true && issues.some((i) => i.severity === 'warning'));
      if (values['json']) {
        io.out(JSON.stringify({ valid: !bad, issues }, null, 2));
      } else {
        const shown = issues.filter((i) => i.severity !== 'info');
        if (shown.length) io.out(formatIssues(shown));
        const count = (s: string) => issues.filter((i) => i.severity === s).length;
        io.out(
          `${bad ? 'Invalid' : 'Valid'}: ${opened.project.ids.shots.length} shots, ${opened.project.assets.assets.length} assets, ${count('error')} errors, ${count('warning')} warnings`,
        );
      }
      return bad ? 1 : 0;
    },
  },
  {
    name: 'pack',
    usage: 'sbd pack <dir> [-o story.sbd] [--force]',
    summary: 'Zip an unpacked storyboard into a .sbd file',
    details:
      'Default output: next to the folder, "<name>.sbd" (or "<name>-packed.sbd" if the folder is already called <name>.sbd).',
    options: { output: { type: 'string', short: 'o' }, force: { type: 'boolean' } },
    async run({ positionals, values }, io) {
      const dir = resolve(need(positionals, 0, '<dir>'));
      const opened = await openProjectPath(dir);
      if (opened.kind !== 'folder') throw new UsageError(`${dir} is not a folder`);
      if (hasErrors(opened.issues) && !values['force']) {
        io.err(formatIssues(opened.issues.filter((i) => i.severity === 'error')));
        io.err('Not packed: fix the errors above or pass --force.');
        return 1;
      }
      const out = resolve(
        (values['output'] as string | undefined) ?? defaultOutput(dir, '.sbd', '-packed'),
      );
      const r = await packFolder(dir, out);
      io.out(`Packed ${r.files} files into ${out} (${(r.bytes / 1024).toFixed(1)} KiB)`);
      return 0;
    },
  },
  {
    name: 'unpack',
    usage: 'sbd unpack <story.sbd> [-o dir]',
    summary: 'Extract a .sbd file into a folder',
    details: 'Default output: next to the file, "<name>-unpacked.sbd/".',
    options: { output: { type: 'string', short: 'o' } },
    async run({ positionals, values }, io) {
      const file = resolve(need(positionals, 0, '<story.sbd>'));
      const out = resolve(
        (values['output'] as string | undefined) ?? defaultOutput(file, '.sbd', '-unpacked'),
      );
      const r = await unpackFile(file, out);
      io.out(`Unpacked ${r.files} files into ${out}`);
      return 0;
    },
  },
  {
    name: 'import-fountain',
    usage:
      'sbd import-fountain <script.fountain> [-o dir] [--preset P] [--title T] [--split paragraph|scene|none]',
    summary: 'Create a storyboard from a Fountain script',
    details: 'Initial shots: one per paragraph/dialogue block (default), one per scene, or none.',
    options: {
      output: { type: 'string', short: 'o' },
      preset: { type: 'string' },
      title: { type: 'string' },
      split: { type: 'string' },
    },
    async run({ positionals, values }, io) {
      const file = resolve(need(positionals, 0, '<script.fountain>'));
      const split = (values['split'] as string | undefined) ?? 'paragraph';
      if (!['paragraph', 'scene', 'none'].includes(split))
        throw new UsageError('--split must be paragraph, scene or none');
      const out = resolve(
        (values['output'] as string | undefined) ?? defaultOutput(file, '.sbd', '-storyboard'),
      );
      const preset = presetOption(values['preset']);
      const r = await importFountainFile(file, out, {
        split: split as ShotSplit,
        ...(preset ? { preset } : {}),
        ...(values['title'] ? { title: values['title'] as string } : {}),
      });
      io.out(`Created ${out}: ${r.lines} script lines in ${r.shots} shots`);
      return 0;
    },
  },
  {
    name: 'export-fountain',
    usage: 'sbd export-fountain <path> [-o script.fountain]',
    summary: 'Write the script as plain Fountain (stdout by default)',
    options: { output: { type: 'string', short: 'o' } },
    async run({ positionals, values }, io) {
      const opened = await openProjectPath(need(positionals, 0, '<path>'));
      await opened.close();
      const text = exportFountain(opened.project);
      if (values['output']) {
        await writeText(values['output'] as string, text);
        io.out(`Wrote ${resolve(values['output'] as string)}`);
      } else io.out(text.replace(/\n$/, ''));
      return 0;
    },
  },
  {
    name: 'import-storyboarder',
    usage: 'sbd import-storyboarder <scene.storyboarder> [-o dir] [--preset P] [--title T]',
    summary: 'Create a storyboard from a Storyboarder scene',
    details: [
      'Reads the .storyboarder file and the images/ folder next to it.',
      'Each board becomes a shot: drawing layers become a canvas variant, action and dialogue',
      'become script lines, notes go into the Notes field, board audio becomes a shot cue.',
      'Default output: next to the file, "<name>.sbd/". Default preset: film.',
    ].join('\n'),
    options: {
      output: { type: 'string', short: 'o' },
      preset: { type: 'string' },
      title: { type: 'string' },
    },
    async run({ positionals, values }, io) {
      const file = resolve(need(positionals, 0, '<scene.storyboarder>'));
      const out = resolve(
        (values['output'] as string | undefined) ?? defaultOutput(file, '.sbd', '-storyboard'),
      );
      const preset = presetOption(values['preset']);
      const r = await importStoryboarderFile(file, out, {
        ...(preset ? { preset } : {}),
        ...(values['title'] ? { title: values['title'] as string } : {}),
      });
      for (const w of r.warnings) io.err(`warning: ${w}`);
      io.out(`Created ${out}: ${r.shots} shots, ${r.lines} script lines, ${r.assets} assets`);
      io.out(`Next: sbd serve "${out}"`);
      return 0;
    },
  },
  {
    name: 'clean',
    usage: 'sbd clean <dir> [--yes] [--json]',
    summary: 'List (or delete with --yes) files in media/ that nothing uses',
    details:
      'Dry run by default: prints the unused files. --yes deletes them. Only files inside media/ are ever touched.',
    options: { yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' } },
    async run({ positionals, values }, io) {
      const dir = resolve(need(positionals, 0, '<dir>'));
      const unused = await findUnusedMedia(dir);
      const total = unused.reduce((s, f) => s + f.bytes, 0);
      const size = (n: number) =>
        n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`;
      if (values['yes'] && unused.length)
        await removeMediaFiles(
          dir,
          unused.map((f) => f.path),
        );
      if (values['json']) {
        io.out(JSON.stringify({ deleted: !!values['yes'], files: unused, bytes: total }, null, 2));
        return 0;
      }
      if (!unused.length) {
        io.out('No unused media files.');
        return 0;
      }
      for (const f of unused) io.out(`  ${f.path}  (${size(f.bytes)})`);
      io.out(
        values['yes']
          ? `Deleted ${unused.length} unused file${unused.length > 1 ? 's' : ''} (${size(total)}).`
          : `${unused.length} unused file${unused.length > 1 ? 's' : ''} (${size(total)}). Run again with --yes to delete ${unused.length > 1 ? 'them' : 'it'}.`,
      );
      return 0;
    },
  },
  {
    name: 'export-pdf',
    usage:
      'sbd export-pdf <path> [-o story.pdf] [--layout grid|rows] [--per 3|6|9|12] [--paper letter|a4] [--no-lines] [--no-fields] [--no-notes] [--no-title] [--browser PATH]',
    summary: 'Print storyboard sheets to a PDF',
    details: [
      'grid = N frames per page with text below (landscape, default 6); rows = one shot per row,',
      'script beside the image (portrait). Uses an installed Chrome/Edge (or Playwright Chromium)',
      'in the background; the result matches File → Export PDF in the app.',
    ].join('\n'),
    options: {
      output: { type: 'string', short: 'o' },
      layout: { type: 'string' },
      per: { type: 'string' },
      paper: { type: 'string' },
      'no-lines': { type: 'boolean' },
      'no-fields': { type: 'boolean' },
      'no-notes': { type: 'boolean' },
      'no-title': { type: 'boolean' },
      browser: { type: 'string' },
    },
    async run({ positionals, values }, io) {
      const path = resolve(need(positionals, 0, '<path>'));
      const layout = (values['layout'] as string | undefined) ?? 'grid';
      if (layout !== 'grid' && layout !== 'rows')
        throw new UsageError('--layout must be grid or rows');
      const per = Number(values['per'] ?? 6);
      if (![3, 6, 9, 12].includes(per)) throw new UsageError('--per must be 3, 6, 9 or 12');
      const paper = (values['paper'] as string | undefined) ?? 'letter';
      if (paper !== 'letter' && paper !== 'a4')
        throw new UsageError('--paper must be letter or a4');
      const out = resolve(
        (values['output'] as string | undefined) ?? defaultOutput(path, '.pdf', '-storyboard'),
      );
      const r = await exportPdf(
        path,
        out,
        {
          layout,
          perPage: per,
          paper,
          lines: !values['no-lines'],
          fields: !values['no-fields'],
          notes: !values['no-notes'],
          titlePage: !values['no-title'],
          ...(values['browser'] ? { browser: values['browser'] as string } : {}),
        },
        (m) => io.err(m),
      );
      io.out(
        `Wrote ${out} (${r.pages} page${r.pages === 1 ? '' : 's'}, ${(r.bytes / 1024).toFixed(0)} KiB)`,
      );
      return 0;
    },
  },
  {
    name: 'serve',
    usage:
      'sbd serve <path> [--port 4400] [--host 127.0.0.1] [--open]\n       sbd serve --workspace <projects> --examples <examples> [--default-project <basename>] [--port 4400] [--host 127.0.0.1] [--open]',
    summary: 'Serve the viewer + storyboard on localhost with live refresh',
    details:
      'Accepts an unpacked folder or a packed .sbd file (live refresh on every change; a packed file is saved in place, its previous version kept once as <file>.bak).\n' +
      'The storyboard is added to the recent list shared by every sbd serve\n' +
      '(~/.config/storyboard-viewer/recent.json; SBD_CONFIG_DIR or XDG_CONFIG_HOME change the folder).\n' +
      'Workspace mode uses separate Projects and read-only Examples roots on one port. An explicit\n' +
      'basename wins; otherwise the newest valid recent project opens, then Midnight Snack.\n' +
      'A missing explicit basename is an error. New and Copy require an explicit user action.\n' +
      'Pause cooperating external writers before rename; independent MCP sessions must reopen.',
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      open: { type: 'boolean' },
      workspace: { type: 'string' },
      examples: { type: 'string' },
      'default-project': { type: 'string' },
    },
    async run({ positionals, values }, io) {
      const workspace = values['workspace'] as string | undefined;
      if (workspace !== undefined && (positionals.length || !values['examples']))
        throw new UsageError('Workspace mode requires --examples and no positional path.');
      if (
        workspace === undefined &&
        (values['examples'] !== undefined || values['default-project'] !== undefined)
      )
        throw new UsageError('--examples and --default-project require --workspace.');
      const store =
        workspace === undefined ? ProjectStore.open(need(positionals, 0, '<path>')) : undefined;
      const port = values['port'] ? Number(values['port']) : 4400;
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new UsageError('--port must be a number');
      const options = {
        port,
        host: (values['host'] as string | undefined) ?? '127.0.0.1',
        recent: true,
        log: (m: string) => io.err(m),
      };
      const srv = store
        ? await startServer(store, options)
        : await startWorkspaceServer({
            ...options,
            workspace: workspace!,
            examples: values['examples'] as string,
            ...(values['default-project'] !== undefined
              ? { defaultProject: values['default-project'] as string }
              : {}),
          });
      io.out(`Storyboard Viewer: ${srv.url}`);
      for (const u of srv.networkUrls) io.out(`  on your network: ${u}`);
      io.out(`Serving ${store?.path ?? workspace}. Press Ctrl+C to stop.`);
      if (values['open']) openBrowser(srv.url);
      return untilSignal(() => srv.close());
    },
  },
  {
    name: 'mcp',
    usage: 'sbd mcp [path] [--serve] [--port 4400] [--host 127.0.0.1]',
    summary: 'Run the MCP server over stdio (for Claude Code, Codex, …)',
    details:
      'With --serve the same process also serves the viewer, and get_viewer_url returns its URL.',
    options: {
      serve: { type: 'boolean' },
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
    },
    async run({ positionals, values }, io) {
      const { runStdio } = await import('./mcp-stdio.js');
      const path = positionals[0];
      if (path && !existsSync(path)) throw new UsageError(`No storyboard at ${resolve(path)}`);
      return runStdio({
        ...(path ? { path } : {}),
        serve: values['serve']
          ? {
              port: values['port'] ? Number(values['port']) : 4400,
              recent: true,
              ...(values['host'] ? { host: values['host'] as string } : {}),
            }
          : false,
        log: (m) => io.err(m),
      });
    },
  },
];

function help(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    `sbd ${VERSION} — Storyboard Viewer command line (${SBD_MIMETYPE})`,
    '',
    'Usage: sbd <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Options:',
    '  -h, --help     Show help (also: sbd <command> --help)',
    '  -v, --version  Show version',
  ].join('\n');
}

/** Runs the CLI and returns the exit code (long-running commands resolve on Ctrl+C). */
export async function run(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === '-h' || name === '--help' || name === 'help') {
    io.out(help());
    return 0;
  }
  if (name === '-v' || name === '--version') {
    io.out(VERSION);
    return 0;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    io.err(`Unknown command: ${name}\n\n${help()}`);
    return 1;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    io.out(
      [`Usage: ${cmd.usage}`, '', cmd.summary + '.', ...(cmd.details ? [cmd.details] : [])].join(
        '\n',
      ),
    );
    return 0;
  }
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: cmd.options ?? {},
      allowPositionals: true,
      strict: true,
    });
    return await cmd.run(
      { positionals: parsed.positionals, values: parsed.values as Record<string, unknown> },
      io,
    );
  } catch (e) {
    const err = e as Error & { code?: string };
    if (e instanceof UsageError || err.code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`${err.message}\nUsage: ${cmd.usage}`);
      return 2;
    }
    io.err(`sbd ${cmd.name}: ${err.message}`);
    return 1;
  }
}
