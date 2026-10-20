/** Single-writer, checksummed snapshots. A failed commit fences this owner until reload. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_TOOLS } from './protocol.js';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(v => canonical(v) ?? 'null').join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export class TaskStore {
  constructor(dir, instance) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'tasks.json');
    this.lock = join(dir, 'tasks.lock');
    this.owner = { pid: process.pid, nonce: randomUUID() };
    const acquiring = `${this.lock}.acquiring`;
    let guard;
    try { guard = openSync(acquiring, 'wx', 0o600); }
    catch { throw new Error('storage_lock_acquisition_in_progress_or_manual_check_required'); }
    try {
      // A stale owner can only be replaced after its process has exited. Never steal a live lock.
      if (existsSync(this.lock)) {
        let old;
        try { old = JSON.parse(readFileSync(this.lock, 'utf8')); }
        catch { throw new Error('storage_lock_unreadable_manual_check_required'); }
        if (!Number.isInteger(old.pid) || old.pid < 1) throw new Error('storage_lock_unreadable_manual_check_required');
        try { process.kill(old.pid, 0); throw new Error('storage_already_owned'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        unlinkSync(this.lock);
      }
      const fd = openSync(this.lock, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(this.owner)); fsyncSync(fd); }
      finally { closeSync(fd); }
    } finally { closeSync(guard); unlinkSync(acquiring); }
    this.instance = instance;
    try {
      this.data = this.load();
      if (!existsSync(this.path) || this.repairedEventCursors) this.save(this.data);
    } catch (error) { this.close(); throw error; }
  }

  load() {
    if (!existsSync(this.path)) return { version: 1, instance_id: this.instance, tasks: [], requests: [] };
    try {
      const { checksum, data } = JSON.parse(readFileSync(this.path, 'utf8'));
      if (checksum !== sha256(canonical(data)) || data.version !== 1 || data.instance_id !== this.instance ||
          !Array.isArray(data.tasks) || !Array.isArray(data.requests)) throw new Error();
      if (data.tasks.length > 100 || data.requests.length > 2000 || new Set(data.tasks.map(t => t.id)).size !== data.tasks.length ||
          new Set(data.requests.map(r => r.id)).size !== data.requests.length) throw new Error();
      for (const task of data.tasks) {
        TASK_TOOLS.task_submit.schema.parse({ request_id: 'stored', ...task.spec });
        if (typeof task.id !== 'string' || !Number.isSafeInteger(task.revision) || task.revision < 1 ||
            typeof task.workspace_claimed !== 'boolean' ||
            !Number.isSafeInteger(task.native_cursor) || task.native_cursor < -1 || !task.creation ||
            !['dispatching', 'running', 'execution_completed', 'awaiting_review', 'changes_requested', 'accepted', 'failed', 'needs_human', 'waiting_approval', 'cancel_requested', 'cancelled'].includes(task.state) ||
            !Array.isArray(task.events) || !Array.isArray(task.evidence) || !Array.isArray(task.reviews) || !Array.isArray(task.runs) ||
            task.events.length > 256 || task.evidence.length > 512 || task.runs.length > 20 ||
            (task.run && canonical(task.run) !== canonical(task.runs.at(-1)))) throw new Error();
        if (!Number.isSafeInteger(task.event_seq) || task.event_seq < task.events.length) throw new Error();
        // Older recovery events spread the native log cursor over the bridge
        // cursor. The retained ring is contiguous: its durable total and array
        // order recover the exact bridge ordinals without touching native logs.
        for (const [index, event] of task.events.entries()) {
          const cursor = task.event_seq - task.events.length + index + 1;
          if (event.type === 'reconciled' && event.native_cursor === undefined &&
              Number.isSafeInteger(event.cursor) && event.cursor >= -1 &&
              typeof event.source === 'string' && ['inspect', 'dispatch_prepared'].includes(event.action)) {
            event.native_cursor = event.cursor;
            event.cursor = cursor;
            this.repairedEventCursors = true;
          }
          if (event.cursor !== cursor) throw new Error();
        }
      }
      for (const record of data.requests) {
        TASK_TOOLS[record.request.name].schema.parse(record.request.args);
        if (record.hash !== sha256(canonical(record.request)) || record.id !== record.request.args.request_id ||
            !['pending', 'completed', 'failed'].includes(record.status) ||
            (record.task_id && !data.tasks.some(t => t.id === record.task_id))) throw new Error();
      }
      return data;
    } catch { throw new Error('storage_corrupt_or_wrong_instance_manual_check_required'); }
  }

  save(data) {
    if (this.failed || this.closed) throw new Error('storage_unavailable_reload_and_reconcile');
    const temporary = `${this.path}.${this.owner.nonce}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, 'w', 0o600);
      writeFileSync(fd, JSON.stringify({ checksum: sha256(canonical(data)), data }));
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
      const dirfd = openSync(join(this.path, '..'), 'r');
      try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
    } catch {
      this.failed = true;
      throw new Error('storage_write_failed_reload_and_reconcile');
    } finally {
      // Cleanup must not replace the sanitized commit error; an orphan remains private and is never loaded.
      if (fd !== undefined) { try { closeSync(fd); } catch { this.failed = true; } }
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { this.failed = true; }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (existsSync(this.lock) && JSON.parse(readFileSync(this.lock, 'utf8')).nonce === this.owner.nonce) unlinkSync(this.lock);
  }
}
