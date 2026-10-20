/** Disposable native log/queue simulator shared by process-crash tests. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function simulatedNative(dir, workspace, options = {}) {
  const path = join(dir, 'native.json');
  let handler;
  let state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { events: [], queue: [], creates: 0, prompts: 0, effects: 0, turn: 0 };
  const save = () => writeFileSync(path, JSON.stringify(state));
  const native = {
    get data() { return state; },
    reload() { if (existsSync(path)) state = JSON.parse(readFileSync(path, 'utf8')); },
    create: async (cwd, requested) => {
      state.creates++; state.session = options.differentSession ? 'actual-different-session' : requested;
      state.cwd = cwd; save();
      options.afterCreate?.();
      return { sessionId: state.session };
    },
    prompt: async (session, request, text) => {
      if (session !== state.session) throw new Error('wrong_session');
      state.prompts++;
      // Same native request identity deduplicates both the live queue and durable user message.
      if (!state.queue.includes(request) && !state.events.some(e => e.data.source?.rpcId === request)) state.queue.push(request);
      state.text = text; save(); options.afterPrompt?.();
      return { accepted: true };
    },
    continue: (...args) => native.prompt(...args),
    status: () => options.cold ? { status: 'unavailable' } : { status: state.queue.length || state.active ? 'running' : 'idle', cwd: workspace },
    read: async session => {
      if (!state.session || session !== state.session) throw new Error('native_not_found');
      return { cwd: state.cwd, source: options.cold ? 'prepared' : 'live', cursor: state.events.length - 1,
        events: structuredClone(state.events), queued_request_ids: options.cold ? [] : [...state.queue] };
    },
    subscribe: fn => { handler = fn; return () => { handler = undefined; }; },
    emit(type, data, notify = true) {
      const event = { type, data, seq: state.events.length };
      state.events.push(event); save();
      if (notify) handler?.({ kind: 'event', session_id: state.session, event });
      return event;
    },
    error(turn) { handler?.({ kind: 'error', session_id: state.session, turn }); },
    repeat(event) { handler?.({ kind: 'event', session_id: state.session, event }); },
    begin(notify = true) {
      const request = state.queue.shift(); state.active = true; state.turn++; save();
      native.emit('turn/start', { turn: state.turn }, notify);
      native.emit('user/message', { turn: state.turn, source: { kind: 'user', rpcId: request } }, notify);
    },
    finish(notify = true, kind = 'completed') {
      state.effects++; save();
      writeFileSync(join(workspace, 'result.txt'), `effect-${state.effects}\n`);
      native.emit('assistant/message', { turn: state.turn, message: { content: [{ type: 'text', text: 'result.txt verified, exit 0' }] } }, notify);
      native.emit('turn/end', { turn: state.turn, reason: { kind } }, notify);
      state.active = false; save();
      if (notify) handler?.({ kind: 'status', session_id: state.session, status: 'idle' });
    },
  };
  return native;
}
export const taskSpec = workspace => ({ request_id: 'stable-submit', workspace, goal: 'Write result.txt', scope: ['result.txt'], out_of_scope: ['External services'], constraints: ['No delegation'], acceptance: ['File verified'] });
