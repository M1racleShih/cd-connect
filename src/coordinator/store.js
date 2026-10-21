/** Private independent journal; a failed commit fences all further operations. */
import { constants as C, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, sha256 } from '../storage.js';
import { stateSchema, ownerSchema, fail } from './schema.js';
export function privateDir(dir, create = true) {
  if (resolve(dir) !== dir) fail('state_path_not_absolute_canonical');
  let p = parse(dir).root;
  for (const part of dir.slice(p.length).split('/').filter(Boolean)) {
    p = join(p, part);
    if (!existsSync(p) && create) mkdirSync(p, { mode: 0o700 });
    if (!lstatSync(p).isDirectory()) fail('state_path_symlink_or_not_directory');
  }
  const s = lstatSync(dir);
  if ((s.mode & 0o077) || s.uid !== process.getuid()) fail('state_directory_not_private');
}
export function readPrivate(path) {
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 16 * 1024 * 1024 || (s.mode & 0o077) || s.uid !== process.getuid()) fail('unsafe_state_file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function processIdentity(pid) {
  // PID reuse is never evidence of death. Boot and start identity aid manual inspection.
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { boot: readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(), start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
}
export class Journal {
  constructor(dir, initial, hooks = {}) {
    privateDir(dir); this.dir = dir; this.path = join(dir, 'state.json'); this.lock = join(dir, 'owner.json'); this.hooks = hooks;
    this.owner = { pid: process.pid, nonce: randomUUID(), ...processIdentity(process.pid) };
    const guard = join(dir, 'acquiring'); let fd;
    try { fd = openSync(guard, 'wx', 0o600); } catch { fail('lock_acquisition_manual_check_required'); }
    try {
      if (existsSync(this.lock)) {
        let old;
        try { old = ownerSchema.parse(readPrivate(this.lock)); } catch { fail('lock_corrupt_manual_check_required'); }
        try { process.kill(old.pid, 0); fail('coordinator_already_owned_or_pid_reused'); }
        catch (e) { if (e.code !== 'ESRCH') throw e; }
        unlinkSync(this.lock);
      }
      const lockfd = openSync(this.lock, 'wx', 0o600);
      try { writeFileSync(lockfd, JSON.stringify(this.owner)); fsyncSync(lockfd); } finally { closeSync(lockfd); }
    } finally { closeSync(fd); unlinkSync(guard); }
    try {
      this.data = existsSync(this.path) ? Journal.read(dir) : stateSchema.parse(initial);
      let changed = !existsSync(this.path);
      for (const notice of this.data.notifications) if (notice.status === 'attempted') { notice.status = 'uncertain'; notice.error = 'restart_without_receipt_manual_check'; changed = true; }
      if (['creating', 'attaching'].includes(this.data.lifecycle)) { this.data.lifecycle = 'uncertain'; this.data.error = 'lifecycle_receipt_unknown_manual_check'; changed = true; }
      if (changed) this.save();
    } catch (e) { this.close(); throw e; }
  }
  static read(dir) {
    privateDir(dir, false);
    const { data, checksum } = readPrivate(join(dir, 'state.json'));
    if (checksum !== sha256(canonical(data))) fail('journal_checksum_invalid');
    try { return stateSchema.parse(data); } catch { fail('journal_schema_invalid'); }
  }
  save() {
    if (this.failed || this.closed) fail('journal_fenced_reload_and_reconcile');
    const tmp = join(this.dir, `state-${randomUUID()}.tmp`); let fd;
    try {
      if (readPrivate(this.lock).nonce !== this.owner.nonce) fail('lock_ownership_lost');
      this.data.updated_at = new Date().toISOString(); stateSchema.parse(this.data);
      const bytes = JSON.stringify({ data: this.data, checksum: sha256(canonical(this.data)) });
      if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) fail('journal_capacity_reached');
      this.hooks.beforeSave?.(this.data);
      fd = openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(tmp, this.path);
      const d = openSync(this.dir, C.O_RDONLY | C.O_DIRECTORY); try { fsyncSync(d); } finally { closeSync(d); }
    } catch { this.failed = true; fail('journal_write_failed_reload_and_reconcile'); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(tmp); } catch {} }
  }
  close() {
    if (this.closed) return; this.closed = true;
    try { if (readPrivate(this.lock).nonce === this.owner.nonce) unlinkSync(this.lock); } catch {}
  }
}
export function initialState(config) { return { version: 1, config, lifecycle: 'prepared', cursor: null, baseline_cursor: null, mode: 'initialized', error: null, notifications: [], stats: { waits: 0, timeouts: 0, attempts: 0 }, updated_at: new Date().toISOString() }; }
