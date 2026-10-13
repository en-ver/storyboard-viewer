// Match the pinned metadata-action tag sanitizer, then fit the Docker tag limit.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function imageBranchTag(branch) {
  if (
    typeof branch !== 'string' ||
    !branch ||
    branch.startsWith('-') ||
    branch === '@' ||
    [...branch].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    /[~^:?*[\\]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  ) {
    throw new Error('Expected a valid Git branch name');
  }
  return `branch-${branch.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 121)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = imageBranchTag(process.env['GITHUB_REF_NAME']);
  const output = process.env['GITHUB_OUTPUT'];
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  if (!/^branch-[a-zA-Z0-9._-]{1,121}$/.test(tag)) throw new Error('Invalid image branch tag');
  appendFileSync(output, `tag=${tag}\n`);
}
