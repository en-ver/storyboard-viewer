/** One-port workspace listener. Project-content requests always bind to a store token. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isPresetId } from '@storyboard-viewer/format';
import { readBody, sendError, sendJson, writeAllowed } from './project-http.js';
import { findWebRoot, listenHttp, type RunningServer } from './server.js';
import { isThumbnail, recentFile, removeRecent } from './recent.js';
import { VERSION } from './version.js';
import {
  Workspace,
  type WorkspaceOptions,
  type WorkspaceRootId,
  type WorkspaceSelection,
} from './workspace.js';
import { workspaceError } from './workspace-files.js';

function rootArg(value: unknown): WorkspaceRootId {
  if (value !== 'projects' && value !== 'examples')
    throw workspaceError('root must be projects or examples.');
  return value;
}
function stringArg(value: unknown, field: string): string {
  if (typeof value !== 'string') throw workspaceError(`${field} must be a string.`);
  return value;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw workspaceError('Expected a JSON object.');
  return value as Record<string, unknown>;
}

export async function startWorkspaceServer(opts: WorkspaceOptions): Promise<RunningServer> {
  const workspace = new Workspace(opts, opts.webRoot === undefined ? findWebRoot() : opts.webRoot);
  const control = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    selected?: WorkspaceSelection,
  ): Promise<boolean> => {
    const path = url.pathname;
    const read = req.method === 'GET' || req.method === 'HEAD';
    // Root-only workspace operations cannot deadlock a retiring project's write drain.
    if (!selected && path === '/api/health' && read) {
      sendJson(res, 200, {
        ok: true,
        app: 'sbd',
        version: VERSION,
        mode: 'workspace',
        initial: workspace.initial,
      });
      return true;
    }
    if (!selected && path === '/api/workspace' && read) {
      sendJson(res, 200, await workspace.listing());
      return true;
    }
    if (path === '/api/recent' && read) {
      sendJson(res, 200, {
        ...workspace.recent(),
        current: selected?.path ?? workspace.initial.path,
        file: recentFile(),
      });
      return true;
    }
    if (read) return false;
    if (!writeAllowed(req)) {
      sendError(res, 403, 'Writes must come from the Storyboard Viewer app on this server');
      return true;
    }
    if (path === '/api/recent' && req.method === 'DELETE') {
      const which = url.searchParams.get('path');
      const allowed = workspace.recent();
      if (which && !workspace.identify(which))
        throw workspaceError('Only allowed workspace history entries can be forgotten.', 403);
      for (const entry of allowed.recent)
        if (!which || entry.path === which) removeRecent(entry.path, { strict: true });
      sendJson(res, 200, { ok: true, ...workspace.recent(), warnings: allowed.warnings });
      return true;
    }
    if (path === '/api/recent/thumbnail' && req.method === 'PUT') {
      if (!selected) throw workspaceError('Use the selected project URL for thumbnails.');
      const input = await body(req);
      if (!isThumbnail(input['thumbnail']))
        throw workspaceError('thumbnail must be a small image data URI.');
      const ok = await workspace.thumbnail(selected, input['thumbnail']);
      sendJson(res, 200, { ok });
      return true;
    }
    if (path === '/api/open' && req.method === 'POST') {
      const input = await body(req);
      const target = workspace.identify(stringArg(input['path'], 'path'));
      if (!target)
        throw workspaceError('Only immediate-child workspace projects can be opened.', 403);
      const opened = await workspace.open(target.root, target.name);
      sendJson(res, 200, {
        ...opened,
        ...(selected?.token === opened.token ? { current: true } : {}),
      });
      return true;
    }
    if (selected || req.method !== 'POST') return false;
    if (path === '/api/workspace/open') {
      const input = await body(req);
      sendJson(
        res,
        200,
        await workspace.open(rootArg(input['root']), stringArg(input['name'], 'name')),
      );
      return true;
    }
    if (path === '/api/workspace/new') {
      const input = await body(req);
      const preset = input['preset'] ?? 'blank';
      if (typeof preset !== 'string' || !isPresetId(preset))
        throw workspaceError('Unknown preset.');
      sendJson(
        res,
        201,
        await workspace.create(
          stringArg(input['name'], 'name'),
          input['title'] === undefined ? undefined : stringArg(input['title'], 'title'),
          preset,
        ),
      );
      return true;
    }
    if (path === '/api/workspace/copy') {
      const input = await body(req);
      sendJson(
        res,
        201,
        await workspace.copy(
          stringArg(input['example'], 'example'),
          stringArg(input['name'], 'name'),
        ),
      );
      return true;
    }
    if (path === '/api/workspace/rename') {
      const input = await body(req);
      sendJson(
        res,
        200,
        await workspace.rename(
          stringArg(input['token'], 'token'),
          stringArg(input['name'], 'name'),
          input['externalWritersPaused'] === true,
        ),
      );
      return true;
    }
    return false;
  };
  workspace.control = control;
  try {
    await workspace.startup();
    const srv = await listenHttp(async (req, res, url) => {
      const match = /^\/p\/([a-f0-9]{48})(\/.*)$/.exec(url.pathname);
      if (match) {
        const route = workspace.route(match[1]!);
        if (!route || route.retired) {
          sendError(res, 410, 'Project route retired or unknown. Reopen the project.');
          return;
        }
        const scoped = new URL(url);
        scoped.pathname = match[2]!;
        await route.http.handle(req, res, scoped);
        return;
      }
      if (url.pathname.startsWith('/p/')) {
        sendError(res, 410, 'Unknown project route.');
        return;
      }
      if (await control(req, res, url)) return;
      if (url.pathname.startsWith('/api/')) {
        sendError(res, 404, 'Use a project-scoped URL or the workspace API.');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'Method not allowed');
        return;
      }
      await workspace.shell().shell(req, res, url);
    }, opts);
    workspace.attachOrigin(srv.url);
    return {
      ...srv,
      async close() {
        await workspace.close();
        await srv.close();
      },
    };
  } catch (e) {
    await workspace.close();
    throw e;
  }
}
