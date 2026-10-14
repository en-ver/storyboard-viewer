/**
 * Running viewers register themselves in the OS temp dir so `get_viewer_url` (in a separate
 * `sbd mcp` process) can find the `sbd serve` URL for a storyboard.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = () => join(tmpdir(), 'storyboard-viewer');
const fileFor = (projectPath: string) =>
  join(dir(), `serve-${createHash('sha1').update(projectPath).digest('hex').slice(0, 16)}.json`);

export function registerViewer(projectPath: string, url: string): () => void {
  const file = fileFor(projectPath);
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(file, JSON.stringify({ url, path: projectPath, pid: process.pid }));
  } catch {
    return () => {};
  }
  return () => {
    try {
      const cur = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; url?: string };
      // A retired scoped store must not unregister a newer lifetime from this process.
      if (cur.pid === process.pid && cur.url === url) rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
}

/** URL of a live viewer for this storyboard, verified via /api/health; null if none. */
export async function findViewer(projectPath: string): Promise<string | null> {
  const candidates: string[] = [];
  try {
    candidates.push(
      (JSON.parse(readFileSync(fileFor(projectPath), 'utf8')) as { url: string }).url,
    );
  } catch {
    /* no registry entry */
  }
  candidates.push('http://localhost:4400/');
  for (const url of candidates) {
    try {
      const res = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(800) });
      const h = (await res.json()) as { app?: string; path?: string };
      if (h.app === 'sbd' && h.path === projectPath) return url;
    } catch {
      /* not running */
    }
  }
  return null;
}
