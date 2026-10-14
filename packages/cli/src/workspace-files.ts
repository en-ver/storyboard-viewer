/** Workspace-only filesystem boundaries. Legacy serve keeps its existing path semantics. */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeJoin } from '@storyboard-viewer/format/node';

export function workspaceError(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function projectName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9 _.-]*\.sbd$/.test(value) ||
    value.length > 160
  )
    throw workspaceError('Use an immediate-child basename ending in .sbd (no path separators).');
  return value;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Pins both spelling and filesystem identity; replacing a directory cannot retarget a token. */
export class WorkspaceRoot {
  readonly path: string;
  private readonly dev: number;
  private readonly ino: number;

  constructor(path: string) {
    this.path = resolve(path);
    if (realpathSync(this.path) !== this.path || !lstatSync(this.path).isDirectory())
      throw workspaceError(`Workspace root must be an existing real directory: ${this.path}`);
    const st = statSync(this.path);
    this.dev = st.dev;
    this.ino = st.ino;
  }

  assert(): void {
    const st = lstatSync(this.path);
    if (
      !st.isDirectory() ||
      realpathSync(this.path) !== this.path ||
      st.dev !== this.dev ||
      st.ino !== this.ino
    )
      throw workspaceError(`Workspace root changed: ${this.path}`, 409);
  }

  /** Checks every existing component, including the parent of a new write destination. */
  check(path: string, missing = false): string {
    this.assert();
    const abs = resolve(path);
    if (!inside(this.path, abs))
      throw workspaceError('Path is outside its workspace boundary.', 403);
    let at = this.path;
    for (const part of relative(this.path, abs).split(sep).filter(Boolean)) {
      at = join(at, part);
      let st;
      try {
        st = lstatSync(at);
      } catch (e) {
        if (missing && (e as NodeJS.ErrnoException).code === 'ENOENT') return abs;
        throw e;
      }
      if (st.isSymbolicLink() || realpathSync(at) !== at)
        throw workspaceError(`Symlinks are not supported in workspace paths: ${at}`, 403);
    }
    return abs;
  }

  child(name: unknown, missing = false): string {
    return this.check(join(this.path, projectName(name)), missing);
  }
}

/** The owning root and project inode remain fixed for the entire loaded-store lifetime. */
export class ProjectBoundary {
  private readonly dev: number;
  private readonly ino: number;
  readonly folder: boolean;

  constructor(
    readonly root: WorkspaceRoot,
    readonly path: string,
  ) {
    root.check(path);
    const st = lstatSync(path);
    this.dev = st.dev;
    this.ino = st.ino;
    this.folder = st.isDirectory();
    if (!this.folder && !st.isFile()) throw workspaceError('Unsupported project type.');
  }

  assert(): void {
    this.root.check(this.path);
    const st = lstatSync(this.path);
    if (st.dev !== this.dev || st.ino !== this.ino)
      throw workspaceError('Project changed on disk. Reopen it before continuing.', 410);
  }

  file(rel: string, missing = false): string {
    this.assert();
    const abs = safeJoin(this.path, rel);
    if (!this.folder)
      throw workspaceError('Packed projects have no writable filesystem tree.', 403);
    return this.root.check(abs, missing);
  }

  linked(abs: string): string {
    this.assert();
    if (!this.folder || !inside(this.path, abs) || resolve(abs) === this.path)
      throw workspaceError('Linked files must be inside the owning unpacked project.', 403);
    return this.root.check(abs);
  }

  /** Before format helpers read or write, inspect the whole tree, including ignored entries. */
  tree(): void {
    this.assert();
    if (!this.folder) return;
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const abs = this.root.check(join(dir, ent.name));
        if (ent.isDirectory()) walk(abs);
        else if (!ent.isFile()) throw workspaceError(`Unsupported workspace file: ${abs}`, 403);
      }
    };
    walk(this.path);
  }
}

export function rootsOverlap(a: WorkspaceRoot, b: WorkspaceRoot): boolean {
  return inside(a.path, b.path) || inside(b.path, a.path);
}

/** A license may live next to the examples root; it is never a client-supplied path. */
export function exampleLicensePath(examples: WorkspaceRoot): string {
  return join(dirname(examples.path), 'LICENSE');
}
