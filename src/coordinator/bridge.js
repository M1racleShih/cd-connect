import { connectHealth } from '../connection.js';
import { healthSchema, snapshotSchema, pageSchema, fail } from './schema.js';
const allowed = new Set(['bridge_health','task_get','task_wait','task_evidence']);
export class BridgeReader {
  constructor(dir, connector = connectHealth) { this.dir = dir; this.connector = connector; }
  async read(name, args = {}, signal) {
    if (!allowed.has(name)) fail('bridge_write_forbidden');
    const stopped = new Error('wait_stopped'); let abort;
    try {
      this.client ??= await this.connector(this.dir);
      // The SDK wraps abort reasons. Track our own cancellation, rather than
      // relabeling an unrelated error merely because stop was also requested.
      const response = this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 35000 });
      const r = signal ? await new Promise((resolve,reject) => {
        abort=()=>reject(stopped); signal.addEventListener('abort',abort,{once:true});
        response.then(resolve,reject); if(signal.aborted)abort();
      }) : await response;
      if (r.isError) {
        const code = r.structuredContent?.error;
        fail(['cursor_ahead_of_stream','cursor_expired_inspect_DSH','only_current_run_evidence_available','cursor_before_current_run'].includes(code) ? code : 'bridge_read_rejected');
      }
      const value = r.structuredContent;
      return name === 'bridge_health' ? healthSchema.parse(value) : name === 'task_get' ? snapshotSchema.parse(value) : pageSchema.parse(value);
    } catch (e) {
      await this.close();
      if (/^(cursor_|only_current_|bridge_read_rejected)/.test(e.message)) throw e;
      fail(e === stopped ? 'wait_stopped' : 'bridge_unavailable_or_invalid_response');
    } finally { if(abort)signal.removeEventListener('abort',abort); }
  }
  async close() { const c = this.client; this.client = undefined; try { await c?.close(); } catch {} }
}
export function checkBinding(binding, health, task) {
  if (health.instance_id !== binding.instance_id || task.instance_id !== binding.instance_id || task.task_id !== binding.task_id || task.run?.id !== binding.run_id || task.revision !== binding.revision) fail('binding_changed_rearm_required');
  if (health.runtime_id !== binding.runtime_id || task.runtime_id !== binding.runtime_id || task.state === 'needs_recovery') fail('runtime_changed_human_recovery_required');
}
export function validatePage(page, previous, tail) {
  if (page.next_cursor < previous || page.next_cursor > tail) fail('cursor_gap_manual_check_required');
  let cursor = previous;
  for (const item of page.items) { if (item.cursor !== ++cursor) fail('cursor_gap_manual_check_required'); }
  if (cursor !== page.next_cursor || (page.has_more && cursor === previous) || (!page.has_more && cursor !== tail)) fail('cursor_gap_manual_check_required');
}
