/** Legacy one-project listener. The project API is shared with opt-in workspace mode. */
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectHttp, sendError } from './project-http.js';
import { ProjectStore } from './store.js';
import { findViewer, registerViewer } from './registry.js';
import { recordRecent } from './recent.js';

export interface ServeOptions {
  port?: number;
  host?: string;
  /** Directory with the built web app; auto-detected when omitted. */
  webRoot?: string | null;
  watch?: boolean;
  /** List this server for get_viewer_url (default true). */
  register?: boolean;
  /** Record successfully loaded projects in shared history (default false in legacy mode). */
  recent?: boolean;
  log?: (msg: string) => void;
}

export interface RunningServer {
  url: string;
  networkUrls: string[];
  port: number;
  server: Server;
  close(): Promise<void>;
}

export function findWebRoot(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const candidate of [join(here, '../web'), join(here, '../../../apps/web/dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate);
  }
  return null;
}

/** One listener and one error boundary, used by both server modes. */
export async function listenHttp(
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>,
  opts: ServeOptions,
): Promise<RunningServer> {
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res, new URL(req.url ?? '/', 'http://localhost')))
      .catch((e: Error & { status?: number }) => {
        opts.log?.(`error ${req.method} ${req.url}: ${e.message}`);
        if (!res.headersSent)
          sendError(res, e.status ?? (e instanceof SyntaxError ? 400 : 500), e.message);
        else res.destroy();
      });
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4400, host, () => {
      server.off('error', reject);
      done();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shownHost = ['127.0.0.1', '0.0.0.0', '::'].includes(host) ? 'localhost' : host;
  return {
    url: `http://${shownHost}:${port}/`,
    networkUrls: host === '0.0.0.0' || host === '::' ? lanUrls(port) : [],
    port,
    server,
    async close() {
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
    },
  };
}

export async function startServer(
  store: ProjectStore,
  opts: ServeOptions = {},
): Promise<RunningServer> {
  const others = new Map<string, RunningServer>();
  let selfUrl = '';
  const viewerFor = async (target: string): Promise<string> => {
    if (target === store.path) return selfUrl;
    const mine = others.get(target);
    if (mine) return mine.url;
    const live = await findViewer(target);
    if (live) return live;
    const next = ProjectStore.open(target);
    const base = opts.port ?? 4400;
    const ports = base === 0 ? [0] : Array.from({ length: 40 }, (_, i) => base + 1 + i);
    let lastError: unknown;
    for (const port of ports) {
      try {
        const srv = await startServer(next, { ...opts, port });
        others.set(target, srv);
        opts.log?.(`opened ${target} at ${srv.url}`);
        return srv.url;
      } catch (e) {
        lastError = e;
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('No free port');
  };
  const http = createProjectHttp(store, {
    ...opts,
    webRoot: opts.webRoot === undefined ? findWebRoot() : opts.webRoot,
    viewerFor,
  });
  let srv: RunningServer;
  try {
    srv = await listenHttp(http.handle, opts);
  } catch (e) {
    await http.retire();
    throw e;
  }
  selfUrl = srv.url;
  const unregister = opts.register === false ? () => {} : registerViewer(store.path, srv.url);
  if (opts.recent) {
    try {
      const opened = await store.load();
      recordRecent({
        path: store.path,
        title: opened.project.manifest.title || store.name,
        kind: store.kind,
      });
    } catch {
      /* Legacy history remains best effort. */
    }
  }
  return {
    ...srv,
    async close() {
      unregister();
      await http.retire();
      await Promise.all([...others.values()].map((s) => s.close()));
      others.clear();
      await srv.close();
    },
  };
}

function lanUrls(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a!.address}:${port}/`);
}
