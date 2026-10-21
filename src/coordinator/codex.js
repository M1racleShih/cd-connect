/** Official JSONL stdio transport. Never answers approval requests automatically. */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { threadSchema, turnSchema, fail } from './schema.js';
export class CodexStdio extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server','--listen','stdio://'], timeout = 30000 } = {}) {
    super(); this.timeout = timeout; this.pending = new Map(); this.sequence = 0; this.buffer = '';
    this.child = spawn(command, args, { stdio: ['pipe','pipe','pipe'] });
    // Provider stderr is deliberately discarded, never copied into the journal.
    this.child.stderr.resume();
    // Pipe chunks may split a multibyte code point. Decode before JSONL framing.
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) return this.break('codex_response_too_large');
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0,end); this.buffer = this.buffer.slice(end+1);
        try { this.receive(JSON.parse(line)); } catch { this.break('codex_invalid_response'); }
      }
    });
    this.child.stdout.on('end', () => {
      if (this.buffer.length) this.break('codex_invalid_response');
    });
    this.child.on('error', () => this.break('codex_disconnected'));
    this.child.on('exit', () => this.break('codex_disconnected'));
    this.child.stdin.on('error', () => this.break('codex_disconnected'));
  }
  receive(m) {
    if (!m || typeof m !== 'object') fail('codex_invalid_response');
    if (m.method) {
      if (m.id !== undefined) {
        // Pending native approval remains pending. Client/operator must handle it normally.
        this.emit('approval', { method: m.method, id: m.id });
      } else this.emit('notification', m);
      return;
    }
    const p = this.pending.get(m.id); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(m.id);
    if (m.error) p.reject(new Error(Number.isInteger(m.error.code) ? `codex_rpc_${String(m.error.code).replace('-','minus_')}` : 'codex_rpc_error'));
    else if ('result' in m) p.resolve(m.result);
    else p.reject(new Error('codex_invalid_response'));
  }
  break(code) {
    this.dead = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(code)); }
    this.pending.clear(); this.emit('disconnected', code);
  }
  request(method, params = {}) {
    if (this.dead || this.closed) return Promise.reject(new Error('codex_disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('codex_receipt_timeout')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name:'cd_connect_coordinator',title:'cd-connect event coordinator',version:'0.5.0' } });
    this.child.stdin.write(`${JSON.stringify({ method:'initialized',params:{} })}\n`); return result;
  }
  async read(threadId) {
    const r = await this.request('thread/read', { threadId });
    return threadSchema.parse(r.thread);
  }
  async history(threadId) {
    const turns = []; let cursor; const seen = new Set();
    do {
      const page = await this.request('thread/turns/list', { threadId, cursor, limit:50, itemsView:'full',sortDirection:'asc' });
      if (!Array.isArray(page.data)) fail('codex_invalid_history');
      turns.push(...page.data.map(t => turnSchema.parse(t)));
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || turns.length > 1000)) fail('codex_history_limit');
      seen.add(cursor);
    } while(cursor);
    return turns;
  }
  async start(threadId, text) {
    const r = await this.request('turn/start', { threadId, input:[{type:'text',text}] });
    return turnSchema.parse(r.turn);
  }
  async close() {
    if (this.closed) return; this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 3000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
