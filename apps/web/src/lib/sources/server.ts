/** Source backed by `sbd serve` on the same origin: /api/project + /api/events (SSE). */
import {
  classifySrc,
  diffProjectFiles,
  fileVersion,
  serializeProject,
  type AssetInput,
  type Issue,
  type ReanchorSummary,
  type SbdProject,
} from '@storyboard-viewer/format';
import {
  SaveConflictError,
  SaveRejectedError,
  type LoadedProject,
  type MediaResolver,
  type ProjectSource,
} from './types';

interface ProjectResponse {
  project: SbdProject;
  issues: Issue[];
  files: string[];
  media: Record<string, { size: number; mtime: number }>;
  reanchor: ReanchorSummary | null;
  revision: number;
  source: {
    kind: 'folder' | 'packed';
    name: string;
    path: string;
    readOnly: boolean;
    base?: string;
    workspace?: ProjectSource['workspace'];
  };
}

/**
 * Whether this page may talk to `sbd serve`: its index.html carries a marker added by the server
 * (or this is the Vite dev server, which can proxy /api). A hosted copy of the app on any other
 * static server has no marker, so it never requests /api (no failing requests, works offline).
 */
export function servedBySbd(): boolean {
  if (import.meta.env.DEV) return true;
  return typeof document !== 'undefined' && !!document.querySelector('meta[name="sbd-serve"]');
}

/** Root workspace health has a mode and initial selection; legacy/project health does not. */
export interface ServerHealth {
  app: 'sbd';
  mode?: 'workspace';
  initial?: { url: string };
  name?: string;
  path?: string;
  readOnly?: boolean;
}

/** Read live metadata, never cached shell selection or mode markers. */
export async function serverHealth(base = ''): Promise<ServerHealth | null> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/health`, { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    const health = (await res.json()) as ServerHealth;
    return health.app === 'sbd' ? health : null;
  } catch {
    return null;
  }
}

/** Detects a live server source at the supplied prefix, or the listener's root. */
export async function detectServer(base = ''): Promise<ProjectSource | null> {
  base = base.replace(/\/+$/, '');
  try {
    const health = await serverHealth(base);
    if (!health) return null;
    if (health.mode === 'workspace' && health.initial) {
      base = health.initial.url.replace(/\/+$/, '');
    }
    const project = await fetch(`${base}/api/project`, { cache: 'no-store' });
    if (!project.ok) throw new Error(`Could not load storyboard: ${project.status}`);
    const data = (await project.json()) as ProjectResponse;
    return serverSource(
      base,
      data.source.name,
      data.source.path,
      data.source.readOnly,
      data.source.workspace,
    );
  } catch {
    return null;
  }
}

function resolver(base: string, media: ProjectResponse['media']): MediaResolver {
  return {
    url(src) {
      const info = classifySrc(src);
      if (!info) return null;
      if (info.kind === 'remote') return info.url;
      if (info.kind === 'linked') return `${base}/api/linked?src=${encodeURIComponent(src)}`;
      const v = media[info.path]?.mtime;
      const path = info.path.split('/').map(encodeURIComponent).join('/');
      return `${base}/api/files/${path}${v ? `?v=${v}` : ''}`;
    },
    reason(src) {
      const info = classifySrc(src);
      if (!info) return 'Invalid source';
      if (info.kind === 'embedded' && !media[info.path]) return `${info.path} is missing`;
      return null;
    },
  };
}

export function serverSource(
  base: string,
  name: string,
  path: string,
  readOnly: boolean,
  workspace?: ProjectSource['workspace'],
): ProjectSource {
  base = base.replace(/\/+$/, '');
  const post = async (
    url: string,
    client: string,
    init: RequestInit,
  ): Promise<{ asset: AssetInput }> => {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'x-sbd-client': client },
    });
    const body = (await res.json().catch(() => ({}))) as { asset?: AssetInput; error?: string };
    if (!res.ok || !body.asset) throw new Error(body.error ?? `Server error ${res.status}`);
    return { asset: body.asset };
  };
  return {
    kind: 'server',
    name,
    readOnly,
    location: path,
    url: base,
    workspace,
    saveMode: readOnly ? 'none' : 'server',
    async load(): Promise<LoadedProject> {
      const res = await fetch(`${base}/api/project`, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }
      const data = (await res.json()) as ProjectResponse;
      if (data.source.readOnly !== readOnly)
        throw new Error('Project permissions changed. Reopen the storyboard.');
      return {
        project: data.project,
        issues: data.issues,
        reanchor: data.reanchor,
        media: resolver(base, data.media),
        files: data.files,
      };
    },
    watch(onChange) {
      const es = new EventSource(`${base}/api/events`);
      es.addEventListener('change', (e) => {
        let origin: string | null = null;
        try {
          origin =
            (JSON.parse((e as MessageEvent<string>).data) as { origin?: string }).origin ?? null;
        } catch {
          /* old server */
        }
        onChange({ origin });
      });
      // After a reconnect (server restarted), refresh once.
      let opened = false;
      es.addEventListener('open', () => {
        if (opened) onChange({});
        opened = true;
      });
      return () => es.close();
    },
    ...(readOnly
      ? {}
      : {
          async save({ base: from, project, client }: import('./types').SaveRequest) {
            const changes = diffProjectFiles(from, project);
            if (!Object.keys(changes).length) return { project: from };
            const files = serializeProject(from);
            const versions = Object.fromEntries(
              Object.keys(changes).map((k) => [k, fileVersion(files[k])]),
            );
            const res = await fetch(`${base}/api/project`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json', 'x-sbd-client': client },
              body: JSON.stringify({ changes, base: versions }),
            });
            const body = (await res.json().catch(() => ({}))) as {
              project?: SbdProject;
              error?: string;
              conflicts?: string[];
              issues?: Issue[];
              readOnly?: boolean;
            };
            if (res.status === 409 && body.conflicts) throw new SaveConflictError(body.conflicts);
            if (res.status === 422)
              throw new SaveRejectedError(body.error ?? 'Invalid edit', body.issues);
            if (!res.ok || !body.project)
              throw new Error(body.error ?? `Server error ${res.status}`);
            return { project: body.project, message: `Saved to ${name}` };
          },
          uploadMedia: async (file: File, client: string) =>
            (
              await post(`${base}/api/media?name=${encodeURIComponent(file.name)}`, client, {
                method: 'POST',
                body: file,
              })
            ).asset,
          linkPath: async (p: string, client: string) =>
            (
              await post(`${base}/api/link`, client, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: p }),
              })
            ).asset,
        }),
    async packed() {
      const res = await fetch(`${base}/api/download`);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      return res.blob();
    },
    dispose() {},
  };
}
