import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TaskManager } from '../src/tasks.js';
import { nativeAdapter } from '../src/native.js';
import { TASK_TOOLS, TOOL_NAMES } from '../src/protocol.js';
import { listenHealth } from '../src/server.js';
import { writeFile, mkdir } from 'node:fs/promises';

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'cd-connect-task-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let handler;
  let seq = 0;
  let turn = 0;
  const native = {
    session: 'actual-native-session', current: { status: 'idle', cwd: workspace }, prompts: [],
    create: async cwd => { assert.equal(cwd, workspace); return { sessionId: native.session }; },
    prompt: async (session, request, text) => {
      assert.equal(session, native.session);
      native.prompts.push({ session, request, text });
      native.current.status = 'running';
      return { accepted: true };
    },
    continue: (...args) => native.prompt(...args),
    status: () => ({ ...native.current }),
    subscribe: fn => { handler = fn; return () => { handler = undefined; }; },
    event: (type, data) => handler?.({ kind: 'event', session_id: native.session, event: { type, data, seq: seq++ } }),
    begin: () => {
      native.event('turn/start', { turn: ++turn });
      native.event('user/message', { source: { kind: 'user', rpcId: native.prompts.at(-1).request } });
    },
    assistant: (content = [{ type: 'text', text: 'Changed file, SHA-256, test command and exit 0.' }]) => native.event('assistant/message', { turn, message: { content } }),
    finish: (kind = 'completed') => native.event('turn/end', { turn, reason: { kind } }),
    idle: () => { native.current.status = 'idle'; handler?.({ kind: 'status', session_id: native.session, status: 'idle' }); },
  };
  const manager = new TaskManager(native, { instance_id: 'fixture-instance', runtime_id: 'fixture-runtime' }, { stateDir: await mkdtemp(join(tmpdir(), 'cd-connect-ledger-')) });
  t.after(async () => { await manager.close(); await rm(join(manager.store.path, '..'), { recursive: true, force: true }); });
  const spec = { request_id: 'submit-1', workspace, goal: 'Write a small greeting file', scope: ['greeting.txt'], out_of_scope: ['Other files'], constraints: ['No external actions'], acceptance: ['File contains hello'] };
  const submit = () => manager.call('task_submit', spec);
  const get = task => manager.call('task_get', { task_id: task.task_id });
  const evidence = task => manager.call('task_evidence', { task_id: task.task_id, run_id: task.run.id });
  const review = (task, items, decision = 'changes_requested', request_id = 'review-1') => manager.call('task_review', {
    task_id: task.task_id, run_id: task.run.id, expected_revision: task.revision, request_id, decision,
    comment: decision === 'accepted' ? 'Checked output and verification' : 'Change hello to hello world and rerun checks', evidence_ids: items.map(e => e.id),
  });
  return { workspace, native, manager, spec, submit, get, evidence, review };
}

test('submit, execution completion, evidence, concrete rework, same-session continuation and acceptance', async t => {
  const f = await fixture(t);
  let task = await f.submit();
  assert.equal(task.session_id, f.native.session);
  assert.equal(task.state, 'running');
  assert.match(f.native.prompts[0].text, /Acceptance criteria/);
  assert.match(f.native.prompts[0].text, /Do not delegate/);
  assert.equal(f.native.prompts.length, 1);
  f.native.begin(); f.native.assistant(); f.native.finish();
  task = await f.get(task);
  assert.equal(task.state, 'execution_completed');
  assert.equal(task.run.execution_completed, true);
  await assert.rejects(f.review(task, (await f.evidence(task)).items), /current_run_not_awaiting_review/);
  f.native.idle();
  task = await f.get(task);
  assert.equal(task.state, 'awaiting_review');
  const firstEvidence = (await f.evidence(task)).items;
  assert.equal(firstEvidence.length, 2);
  assert.match(firstEvidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(firstEvidence[0].native_ref.session_id, task.session_id);
  task = await f.review(task, firstEvidence, 'changes_requested', 'review-2');
  assert.equal(task.state, 'changes_requested');
  assert.equal(task.revision, 2);
  task = await f.manager.call('task_continue', { task_id: task.task_id, run_id: task.run?.id, request_id: 'continue-1', expected_revision: 2, instruction: 'Change hello to hello world and rerun checks.' });
  assert.equal(task.revision, 3);
  assert.equal(f.native.prompts.length, 2);
  assert.notEqual(f.native.prompts[0].request, f.native.prompts[1].request);
  assert.match(f.native.prompts[1].text, /## Continuation instruction\n\nChange hello to hello world and rerun checks\./);
  for (const value of [f.spec.goal, ...f.spec.scope, ...f.spec.out_of_scope, ...f.spec.constraints, ...f.spec.acceptance]) assert.ok(f.native.prompts[1].text.includes(value));
  f.native.begin(); f.native.assistant(); f.native.finish(); f.native.idle();
  task = await f.get(task);
  const finalEvidence = (await f.evidence(task)).items;
  assert.ok(finalEvidence.every(e => e.run_id === task.run.id));
  assert.equal(finalEvidence.length, 2);
  task = await f.review(task, finalEvidence, 'accepted', 'review-3');
  assert.equal(task.state, 'accepted');
  assert.equal(task.reviews.length, 2);
  assert.equal(task.next_action, 'done_or_authorized_next_stage');
});

test('real HTTP and stdio share task state, discover schemas and reject invalid controls', async t => {
  const f = await fixture(t);
  const token = 'b'.repeat(64);
  const endpoint = await listenHealth({ port: 0, token, readHealth: () => ({ bridge: { phase: 1 } }), tasks: f.manager });
  t.after(() => endpoint.close());
  const direct = new Client({ name: 'task-http-test', version: '1' });
  await direct.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => direct.close());
  const stateDir = join(f.workspace, 'discovery');
  await mkdir(stateDir);
  await writeFile(join(stateDir, 'connection.json'), JSON.stringify({ url: endpoint.url, token }), { mode: 0o600 });
  const stdio = new Client({ name: 'task-stdio-test', version: '1' });
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/stdio.js')], env: { CD_CONNECT_STATE_DIR: stateDir } }));
  t.after(() => stdio.close());
  const catalog = await stdio.listTools();
  assert.deepEqual(catalog.tools.map(x => x.name), TOOL_NAMES);
  assert.equal(catalog.tools.find(x => x.name === 'task_wait').annotations.readOnlyHint, true);
  assert.equal(catalog.tools.find(x => x.name === 'task_submit').annotations.readOnlyHint, false);
  assert.equal(catalog.tools.find(x => x.name === 'task_cancel').annotations.readOnlyHint, false);
  assert.equal(catalog.tools.some(x => /approve/.test(x.name)), false);
  const result = await stdio.callTool({ name: 'task_submit', arguments: f.spec });
  assert.equal(result.isError, undefined);
  const task = result.structuredContent;
  const fetched = await direct.callTool({ name: 'task_get', arguments: { task_id: task.task_id } });
  assert.equal(fetched.structuredContent.session_id, f.native.session);
  const invalid = await stdio.callTool({ name: 'task_continue', arguments: { task_id: task.task_id, run_id: task.run?.id, request_id: 'bad', expected_revision: 1, instruction: 'keep going' } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error, 'review_required_before_continue');
  const extraField = await stdio.callTool({ name: 'task_submit', arguments: { ...f.spec, model: 'override' } });
  assert.equal(extraField.isError, true);
  const waiting = stdio.callTool({ name: 'task_wait', arguments: { task_id: task.task_id, cursor: task.event_cursor, timeout_ms: 1000 } });
  setTimeout(() => f.native.begin(), 20);
  assert.equal((await waiting).structuredContent.timed_out, false);
});

test('wait defaults to 25 seconds, wakes on events, times out without completion, and supports cancellation', async t => {
  const f = await fixture(t);
  const task = await f.submit();
  assert.equal(TASK_TOOLS.task_wait.schema.parse({ task_id: task.task_id }).timeout_ms, 25000);
  const args = { task_id: task.task_id, cursor: task.event_cursor, timeout_ms: 10 };
  const timeout = await f.manager.call('task_wait', args);
  assert.equal(timeout.timed_out, true);
  assert.equal(timeout.task.state, 'running');
  const waiting = f.manager.call('task_wait', { ...args, timeout_ms: 1000 });
  setTimeout(() => f.native.begin(), 5);
  const result = await waiting;
  assert.equal(result.timed_out, false);
  assert.ok(result.items.length);
  const abort = new AbortController();
  const cancelled = f.manager.call('task_wait', { ...args, cursor: result.task.event_cursor, timeout_ms: 1000 }, abort.signal);
  setTimeout(() => abort.abort(), 5);
  await assert.rejects(cancelled, /wait_cancelled/);
  const closing = f.manager.call('task_wait', { ...args, cursor: result.task.event_cursor, timeout_ms: 1000 });
  setTimeout(() => f.manager.close(), 5);
  assert.equal((await closing).task.state, 'needs_recovery');
});

test('request identity, revisions and evidence ownership prevent duplicate or stale controls', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.submit(), f.submit()]);
  assert.equal(a.task_id, b.task_id);
  assert.equal(f.native.prompts.length, 1);
  await assert.rejects(f.manager.call('task_submit', { ...f.spec, goal: 'Different goal' }), /request_id_content_conflict/);
  await assert.rejects(f.manager.call('task_submit', { ...f.spec, request_id: 'submit-other' }), /workspace_has_unaccepted_task/);
  f.native.begin(); f.native.assistant(); f.native.finish(); f.native.idle();
  const task = await f.get(a);
  const items = (await f.evidence(task)).items;
  await assert.rejects(f.manager.call('task_review', { task_id: task.task_id, request_id: 'stale', expected_revision: 99, run_id: task.run.id, decision: 'accepted', comment: 'Checked', evidence_ids: [items[0].id] }), /revision_conflict/);
  await assert.rejects(f.manager.call('task_review', { task_id: task.task_id, request_id: 'foreign', expected_revision: 1, run_id: task.run.id, decision: 'accepted', comment: 'Checked', evidence_ids: ['foreign'] }), /invalid_or_expired_evidence_reference/);
  await assert.rejects(f.manager.call('task_evidence', { task_id: task.task_id, run_id: 'foreign' }), /only_current_run/);
  const [r1, r2] = await Promise.all([f.review(task, items), f.review(task, items)]);
  assert.deepEqual(r1, r2);
  assert.equal((await f.get(task)).reviews.length, 1);
});

test('bounded event/evidence pages, native references, truncation and expired cursor errors', async t => {
  const f = await fixture(t);
  const task = await f.submit();
  f.native.begin();
  f.native.assistant([{ type: 'text', text: 'x'.repeat(9000) }]);
  const first = (await f.evidence(task)).items[0];
  assert.equal(first.truncated, true);
  assert.equal(first.preview.length, 8000);
  assert.equal(first.data, undefined);
  for (let i = 0; i < 520; i++) f.native.assistant();
  await assert.rejects(f.manager.call('task_wait', { task_id: task.task_id }), /cursor_expired/);
  await assert.rejects(f.evidence(task), /cursor_expired/);
  const page = await f.manager.call('task_evidence', { task_id: task.task_id, run_id: task.run.id, cursor: 520, limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.next_cursor, 521);
  await assert.rejects(f.manager.call('task_wait', { task_id: task.task_id, limit: 51 }));
  await assert.rejects(f.manager.call('task_wait', { task_id: task.task_id, timeout_ms: 25001 }));
});

test('unrelated native input, failures, and uncertain dispatch never become review acceptance', async t => {
  const f = await fixture(t);
  let task = await f.submit();
  f.native.event('turn/end', { turn: 700, reason: { kind: 'completed' } });
  assert.equal((await f.get(task)).state, 'running');
  f.native.begin();
  f.native.event('user/message', { source: { kind: 'user', rpcId: 'someone-else' } });
  f.native.assistant(); f.native.finish(); f.native.idle();
  assert.equal((await f.get(task)).state, 'needs_human');
  const g = await fixture(t);
  task = await g.submit();
  g.native.begin(); g.native.finish('error'); g.native.idle();
  assert.equal((await g.get(task)).state, 'failed');
  const h = await fixture(t);
  h.native.prompt = async () => { throw new Error('sensitive provider diagnostic'); };
  task = await h.submit();
  assert.equal(task.state, 'needs_human');
  assert.equal(JSON.stringify(task).includes('sensitive'), false);
  assert.deepEqual(await h.submit(), task);
});

test('native adapter uses public create/prompt with queue mode, leaves model and permissions untouched, and detaches events', async () => {
  const calls = [];
  let stopped = 0;
  const controller = { create: async args => { calls.push(args); return { sessionId: 'actual' }; }, prompt: async (args, signal) => { calls.push(args); assert.equal(signal.aborted, false); return { accepted: true }; } };
  const adapter = nativeAdapter({ get: key => ({ workspaceRegistry: { create: async cwd => { assert.equal(cwd, '/tmp'); return { id: 'workspace-fixture' }; } }, sessionController: controller, agents: { get: () => ({ status: 'idle', session: { header: { cwd: '/tmp' } } }) }, sessions: {} })[key], on: () => () => { stopped++; } });
  assert.equal((await adapter.create('/tmp')).sessionId, 'actual');
  await adapter.prompt('actual', 'request', 'hello');
  assert.deepEqual(calls, [{ workspaceId: 'workspace-fixture' }, { sessionId: 'actual', requestId: 'request', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }]);
  assert.deepEqual(adapter.status('actual'), { status: 'idle', cwd: '/tmp' });
  adapter.subscribe(() => {})();
  assert.equal(stopped, 4);
});

test('tool evidence pairs native calls/results without copying raw streams or runtime configuration', async t => {
  const f = await fixture(t);
  const task = await f.submit();
  f.native.begin();
  f.native.event('request/header', { turn: 1, header: { config: { private: 'not-evidence' } } });
  f.native.event('tool/call', { turn: 1, callId: 'native-call', name: 'shell', arguments: '{"command":"check greeting.txt"}' });
  f.native.event('tool/result', { turn: 1, message: { toolCallId: 'native-call', content: [{ type: 'text', text: 'exit status: 0' }] } });
  f.native.event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'verified' }] }, stream: ['not-evidence'] });
  const items = (await f.evidence(task)).items;
  assert.equal(items.length, 3);
  assert.equal(items[0].data.call_id, items[1].data.call_id);
  assert.equal(items[1].data.is_error, false);
  assert.equal(JSON.stringify(items).includes('not-evidence'), false);
  f.native.finish();
  // Another native turn before idle must not be silently included in acceptance.
  f.native.event('turn/start', { turn: 2 });
  f.native.idle();
  assert.equal((await f.get(task)).state, 'needs_human');
});

test('a native turn completing before its prompt receipt is returned remains awaiting review', async t => {
  const f = await fixture(t);
  const original = f.native.prompt;
  f.native.prompt = async (...args) => {
    const receipt = await original(...args);
    f.native.begin(); f.native.assistant(); f.native.finish(); f.native.idle();
    return receipt;
  };
  const task = await f.submit();
  assert.equal(task.state, 'awaiting_review');
  assert.equal(task.run.execution_completed, true);
  assert.equal(task.run.receipt.accepted, true);
});

test('MCP client disconnection leaves native execution and durable evidence intact for a new connection', async t => {
  const f = await fixture(t);
  const token = 'c'.repeat(64);
  const endpoint = await listenHealth({ port: 0, token, tasks: f.manager, readHealth: () => ({ bridge: { phase: 2 } }) });
  t.after(() => endpoint.close());
  const connect = async () => {
    const client = new Client({ name: 'reconnection-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const first = await connect();
  const task = (await first.callTool({ name: 'task_submit', arguments: f.spec })).structuredContent;
  await first.close();
  f.native.begin(); f.native.assistant(); f.native.finish(); f.native.idle();
  const second = await connect(); t.after(() => second.close());
  const fetched = (await second.callTool({ name: 'task_get', arguments: { task_id: task.task_id } })).structuredContent;
  assert.equal(fetched.state, 'awaiting_review'); assert.equal(fetched.storage, 'durable_snapshot_v1');
  const retry = (await second.callTool({ name: 'task_submit', arguments: f.spec })).structuredContent;
  assert.equal(retry.task_id, task.task_id); assert.equal(f.native.prompts.length, 1);
  const evidence = (await second.callTool({ name: 'task_evidence', arguments: { task_id: task.task_id, run_id: task.run.id } })).structuredContent;
  assert.equal(evidence.items.length, 2); assert.equal(evidence.artifacts.valid, true);
});

test('bounded reads remain available while a native receipt is delayed', async t => {
  const f = await fixture(t);
  const prompt = f.native.prompt;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.native.prompt = async (...args) => { const receipt = await prompt(...args); entered(); await gate; return receipt; };
  const submitting = f.submit(); await started;
  const task_id = [...f.manager.tasks.keys()][0];
  const snapshot = await f.manager.call('task_get', { task_id });
  assert.equal(snapshot.state, 'dispatching');
  const waiting = await f.manager.call('task_wait', { task_id, cursor: snapshot.event_cursor, timeout_ms: 5 });
  assert.equal(waiting.timed_out, true); assert.equal(waiting.task.state, 'dispatching');
  release(); assert.equal((await submitting).state, 'running');
});

test('native workspace creation preserves requested identity and never falls back to an ungrouped session', async () => {
  for (const failure of ['registry', 'attachment', 'missing-service', null]) {
    const calls = [];
    const adapter = nativeAdapter({ get: key => ({
      sessions: {}, agents: {},
      workspaceRegistry: failure === 'missing-service' ? undefined : { create: async path => {
        calls.push(['workspace', path]);
        if (failure === 'registry') throw new Error('registry failed');
        return { id: 'existing-workspace' };
      } },
      sessionController: { create: async args => {
        calls.push(['session', args]);
        if (failure === 'attachment') throw new Error('attachment failed');
        return { sessionId: 'actual-native-id' };
      } },
    })[key] });
    const result = adapter.create('/tmp/workspace-example', 'requested-id');
    if (failure) await assert.rejects(result);
    else assert.deepEqual(await result, { sessionId: 'actual-native-id' });
    assert.equal(calls.filter(([kind]) => kind === 'session').length, ['registry', 'missing-service'].includes(failure) ? 0 : 1);
    if (calls.at(-1)?.[0] === 'session') assert.deepEqual(calls.at(-1)[1], { workspaceId: 'existing-workspace', sessionId: 'requested-id' });
  }
});


test('Markdown task description retains every requirement, multiline content and empty exclusions', async t => {
  const f = await fixture(t);
  Object.assign(f.spec, {
    goal: '保留 "引号"、`代码` 与路径 /tmp/example\n第二行目标',
    scope: ['第一项\n补充说明\n\n继续说明', '第二项'],
    out_of_scope: [], constraints: ['禁止提交 Git', '不得扩大权限'],
    acceptance: ['执行检查并报告退出状态'],
  });
  const task = await f.submit();
  const text = f.native.prompts[0].text;
  assert.ok(text.includes(f.spec.goal));
  assert.ok(text.includes(`## Working directory\n\n${f.workspace}`));
  for (const field of ['scope', 'constraints', 'acceptance']) {
    for (const item of f.spec[field]) assert.ok(text.includes(`- ${item.replace(/\n/g, '\n  ')}`));
  }
  assert.ok(text.includes('## Out of scope\n\n(None specified.)'));
  assert.ok(text.includes(`revision 1, run ${task.run.id}`));
  assert.ok(!text.includes('## Continuation instruction'));
  assert.ok(!text.includes('The following JSON'));
  assert.match(text, /Do not claim reviewer acceptance/);
  const retry = await f.submit();
  assert.equal(retry.task_id, task.task_id);
  assert.equal(f.native.prompts.length, 1);
});
