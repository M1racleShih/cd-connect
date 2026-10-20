/** Byte/mode witnesses for local workspace artifacts; never follow symlinks or copy contents. */
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { relative, resolve, sep, join } from 'node:path';
import { sha256 } from './storage.js';

export function overlaps(a, b) {
  const inside = (x, y) => { const r = relative(x, y); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.startsWith(sep)); };
  return inside(a, b) || inside(b, a);
}

export function workspaceWitness(root) {
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('workspace_identity_changed');
  const entries = [];
  let bytes = 0;
  const visit = path => {
    if (entries.length > 20000 || bytes > 128 * 1024 * 1024) throw new Error('workspace_witness_limit');
    const before = lstatSync(path, { bigint: true });
    const name = relative(root, path);
    const mode = String(before.mode);
    if (before.isDirectory()) {
      entries.push([name, mode, 'directory']);
      for (const child of readdirSync(path).sort()) {
        if (child === '.git') continue;
        visit(join(path, child));
      }
    } else if (before.isFile()) {
      bytes += Number(before.size);
      if (bytes > 128 * 1024 * 1024) throw new Error('workspace_witness_limit');
      entries.push([name, mode, sha256(readFileSync(path))]);
    } else if (before.isSymbolicLink()) entries.push([name, mode, 'symlink', readlinkSync(path)]);
    else throw new Error('workspace_witness_unsupported_file');
    const after = lstatSync(path, { bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('workspace_changed_during_witness');
  };
  if (resolve(root) !== root) throw new Error('workspace_not_canonical');
  visit(root);
  if (entries.length > 20000) throw new Error('workspace_witness_limit');
  return { sha256: sha256(JSON.stringify(entries)), entries: entries.length, bytes, policy: 'tree_bytes_modes_symlinks_excluding_dot_git_v1' };
}
