import type { PresetId } from '@storyboard-viewer/format';
import type { SharedRecent } from './sources/cache';

export type WorkspaceRoot = 'examples' | 'projects';
export interface WorkspaceEntry {
  root: WorkspaceRoot;
  name: string;
  path: string;
  title: string;
  kind: 'folder' | 'packed';
  readOnly: boolean;
}
export interface WorkspaceSelection extends WorkspaceEntry {
  token: string;
  url: string;
  warnings: string[];
}
export interface WorkspaceListing {
  mode: 'workspace';
  roots: Record<WorkspaceRoot, { label: string; path: string; readOnly: boolean }>;
  presets: PresetId[];
  projects: WorkspaceEntry[];
  examples: WorkspaceEntry[];
  recent: SharedRecent[];
  initial: WorkspaceSelection;
  diagnostics: string[];
  warnings: string[];
}

/** Tokens and URLs belong to the backend. Never derive them from filesystem names. */
export function projectBase(url: string): string {
  const resolved = new URL(url, location.origin);
  if (resolved.origin !== location.origin || !/^\/p\/[a-f0-9]{48}\/$/.test(resolved.pathname))
    throw new Error('The server returned an invalid project URL.');
  return resolved.pathname.slice(0, -1);
}

async function request<T>(path: string, client?: string, input?: object): Promise<T> {
  const res = await fetch(`/api/workspace${path}`, {
    cache: 'no-store',
    ...(input
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sbd-client': client! },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`);
  return data as T;
}

export function workspaceName(name: string): string {
  const trimmed = name.trim();
  return trimmed.endsWith('.sbd') ? trimmed : `${trimmed}.sbd`;
}

export const workspaceApi = {
  list: () => request<WorkspaceListing>(''),
  open: (client: string, root: WorkspaceRoot, name: string) =>
    request<WorkspaceSelection>('/open', client, { root, name }),
  create: (client: string, name: string, title: string, preset: PresetId) =>
    request<WorkspaceSelection>('/new', client, { name: workspaceName(name), title, preset }),
  copy: (client: string, example: string, name: string) =>
    request<WorkspaceSelection>('/copy', client, { example, name: workspaceName(name) }),
  rename: (client: string, token: string, name: string) =>
    request<WorkspaceSelection>('/rename', client, {
      token,
      name: workspaceName(name),
      externalWritersPaused: true,
    }),
};
