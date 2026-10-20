import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/tasks.js';
import { nativeAdapter } from '../src/native.js';
import { simulatedNative, taskSpec } from './support/native.js';

const records = [];
after(async () => {
  if (!process.env.CD_CONNECT_TEST_EVIDENCE_DIR) return;
  await mkdir(process.env.CD_CONNECT_TEST_EVIDENCE_DIR, { recursive: true });
  await writeFile(join(process.env.CD_CONNECT_TEST_EVIDENCE_DIR, 'controls-matrix.json'), JSON.stringify({
    verification: 'isolated-control-simulator', real_desktop_approval: false, real_desktop_restart: false, records,
  }, null, 2) + '\n', { mode: 0o600 });
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cd-connect-controls-'));
  const workspace = await mkdtemp(join(tmpdir(), 'cd-connect-controls-work-'));
  const native = simulatedNative(dir, workspace);
  let cancellations = 0;
  native.cancel = () => { cancellations++; return { accepted: true }; };
  let generation = 0;
  let manager;
  const reload = async () => {
    await manager?.close();
    manager = new TaskManager(native, { instance_id: 'controls', runtime_id: `generation-${++generation}` }, { stateDir: join(dir, 'ledger') });
  };
  await reload();
  t.after(async () => { records.push({ test: t.name, tasks: [...manager.tasks.values()].map(task => manager.snapshot(task)), cancellations }); await manager.close(); await rm(dir, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); });
  return { native, workspace, get manager() { return manager; }, reload, get cancellations() { return cancellations; },
    submit: () => manager.call('task_submit', taskSpec(workspace)),
    get: task => manager.call('task_get', { task_id: task.task_id }),
    cancel: (task, id = 'cancel') => manager.call('task_cancel', { task_id: task.task_id, run_id: task.run.id, expected_revision: task.revision, request_id: id }),
    inspect: task => manager.call('task_recover', { task_id: task.task_id, expected_revision: task.revision, request_id: `inspect-${generation}`, action: 'inspect' }),
  };
}

test('native approval audit without turn fields wakes waiters, persists pending state, and records a grant', async t => {
  const f = await fixture(t);
  let task = await f.submit(); f.native.begin(); task = await f.get(task);
  const waiting = f.manager.call('task_wait', { task_id: task.task_id, cursor: task.event_cursor, timeout_ms: 1000 });
  f.native.emit('approval/asked', { id: 'approval-1', toolName: 'bash', callId: 'call-1', reason: 'Write the authorized test file' });
  let result = await waiting;
  assert.equal(result.task.state, 'waiting_approval');
  assert.equal(result.task.next_action, 'human_decide_in_DSH');
  assert.equal(result.task.status_detail.pending_approvals[0].call_id, 'call-1');
  result = await f.manager.call('task_wait', { task_id: task.task_id, cursor: result.task.event_cursor });
  assert.equal(result.timed_out, false);
  await f.reload(); task = await f.get(task); assert.equal(task.state, 'needs_recovery');
  task = await f.inspect(task); assert.equal(task.state, 'waiting_approval');
  f.native.emit('approval/decided', { id: 'approval-1', outcome: 'allowed-once' });
  assert.equal((await f.get(task)).state, 'running');
  f.native.finish(); task = await f.get(task); assert.equal(task.state, 'awaiting_review');
  const evidence = await f.manager.call('task_evidence', { task_id: task.task_id, run_id: task.run.id });
  assert.deepEqual(evidence.items.filter(e => e.type.startsWith('approval/')).map(e => e.data.id), ['approval-1', 'approval-1']);
});

for (const outcome of ['rejected', 'unavailable']) test(`approval ${outcome} remains structured permission failure even if model reports completion`, async t => {
  const f = await fixture(t); let task = await f.submit(); f.native.begin();
  f.native.emit('approval/asked', { id: 'denied', toolName: 'bash' });
  f.native.emit('approval/decided', { id: 'denied', outcome });
  f.native.finish(); task = await f.get(task);
  assert.equal(task.state, 'failed'); assert.equal(task.status_detail.category, 'permission_denied');
  assert.equal(task.artifacts, null);
});

test('cancel acceptance is distinct from aborted-and-idle confirmation; retries do not call native twice', async t => {
  const f = await fixture(t); let task = await f.submit();
  await assert.rejects(f.cancel(task, 'queued'), /cancel_requires_matched_active_run/); assert.equal(f.cancellations, 0);
  f.native.begin(); task = await f.get(task);
  const original = task;
  task = await f.cancel(task);
  assert.equal(task.state, 'cancel_requested'); assert.equal(task.run.cancellation.status, 'accepted');
  assert.equal(task.run.execution_completed, false);
  assert.deepEqual(await f.cancel(original), task); assert.equal(f.cancellations, 1);
  f.native.finish(true, 'aborted'); task = await f.get(task);
  assert.equal(task.state, 'cancelled'); assert.equal(task.run.cancellation.status, 'confirmed');
  await f.reload(); task = await f.inspect(await f.get(task)); assert.equal(task.state, 'cancelled');
  assert.equal(f.cancellations, 1);
  const previous = task.run.id;
  task = await f.manager.call('task_continue', { task_id: task.task_id, run_id: previous, expected_revision: task.revision, request_id: 'continue', instruction: 'Inspect effects and reverify result.txt' });
  assert.notEqual(task.run.id, previous);
  await assert.rejects(f.manager.call('task_cancel', { task_id: task.task_id, run_id: previous, expected_revision: task.revision, request_id: 'old-run' }), /run_conflict/);
  assert.equal(f.cancellations, 1);
});

test('a late cancel cannot change completed work, and an accepted cancel losing to completion is not confirmed', async t => {
  const f = await fixture(t); let task = await f.submit(); f.native.begin(); task = await f.get(task);
  task = await f.cancel(task); f.native.finish(); task = await f.get(task);
  assert.equal(task.state, 'awaiting_review'); assert.equal(task.run.cancellation.status, 'not_cancelled');
  await assert.rejects(f.cancel(task, 'late'), /cancel_requires_matched_active_run/); assert.equal(f.cancellations, 1);
});

test('cancel uncertainty across reload never automatically replays the request', async t => {
  const f = await fixture(t); let task = await f.submit(); f.native.begin(); task = await f.get(task);
  f.native.cancel = () => { throw new Error('private native detail'); };
  task = await f.cancel(task); assert.equal(task.state, 'needs_human'); assert.equal(task.run.cancellation.status, 'outcome_unknown');
  await f.reload(); task = await f.inspect(await f.get(task)); assert.equal(task.state, 'needs_human');
  assert.equal(JSON.stringify(task).includes('private native detail'), false);
});

for (const kind of ['error', 'blocked', 'max-tokens', 'interrupted']) test(`native terminal ${kind} cannot enter acceptance`, async t => {
  const f = await fixture(t); let task = await f.submit(); f.native.begin(); f.native.finish(true, kind);
  task = await f.get(task); assert.equal(task.state, 'failed'); assert.equal(task.status_detail.native_end_reason, kind);
  assert.equal(task.status_detail.category, kind === 'error' ? 'model_or_execution_error' : 'execution_failed');
});

function guardFixture() {
  let calls = 0;
  let onResolve = () => {};
  const events = [ { type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'owned-request' } } } ];
  const agent = { status: 'running', session: { header: { cwd: '/tmp' }, snapshotEvents: () => events }, inbox: { nextTurn: [], nextStep: [] },
    followup: message => { calls++; assert.equal(message.source.kind, 'user'); assert.equal(message.source.rpcId, 'next-request'); } };
  const controller = { cancel: () => { calls++; return { accepted: true }; }, resolveAgent: async () => { onResolve(); return { agent }; } };
  const ctx = { get: key => ({ agents: { get: () => agent }, sessionController: controller, sessions: {} })[key] };
  return { agent, events, adapter: nativeAdapter(ctx), get calls() { return calls; }, setResolve: fn => { onResolve = fn; },
    expected: { cwd: '/tmp', cursor: 1, turn: 1, request_id: 'owned-request' } };
}

test('Host synchronous cancel guard rejects late requests, replacement turns, foreign inputs, queued work and changed workspace', () => {
  for (const mutate of [f => { f.agent.status = 'idle'; }, f => { f.events[0].data.turn++; },
    f => { f.events[1].data.source.rpcId = 'foreign'; }, f => { f.events.push({ type: 'turn/end' }); },
    f => { f.agent.inbox.nextTurn.push({}); }, f => { f.agent.session.header.cwd = '/other'; }]) {
    const f = guardFixture(); mutate(f); assert.throws(() => f.adapter.cancel('session', f.expected), /native_run_changed/); assert.equal(f.calls, 0);
  }
  const f = guardFixture(); assert.equal(f.adapter.cancel('session', f.expected).accepted, true); assert.equal(f.calls, 1);
});

test('Host continuation guard rechecks after asynchronous hydration and acts without an admission await', async () => {
  const f = guardFixture(); f.agent.status = 'idle';
  assert.equal((await f.adapter.continue('session', 'next-request', 'authorized text', f.expected)).accepted, true);
  assert.equal(f.calls, 1);
  const changed = guardFixture(); changed.agent.status = 'idle'; changed.setResolve(() => { changed.events.push({ type: 'turn/start', data: { turn: 2 } }); });
  await assert.rejects(changed.adapter.continue('session', 'next-request', 'authorized text', changed.expected), /native_run_changed/);
  assert.equal(changed.calls, 0);
});

test('manual recovery resolves an unknown cancellation from a matching aborted log without sending cancel again', async t => {
  const f = await fixture(t); let task = await f.submit(); f.native.begin(); task = await f.get(task);
  let calls = 0;
  f.native.cancel = () => { calls++; throw new Error('lost acknowledgement'); };
  task = await f.cancel(task); assert.equal(task.state, 'needs_human');
  await f.reload(); f.native.finish(false, 'aborted');
  task = await f.inspect(await f.get(task));
  assert.equal(task.state, 'cancelled'); assert.equal(task.run.cancellation.status, 'confirmed'); assert.equal(calls, 1);
});

test('errors before request consumption and unmatched terminal turns cannot leave the task silently running', async t => {
  const f = await fixture(t); let task = await f.submit();
  f.native.emit('turn/start', { turn: 1 }); f.native.error(1);
  task = await f.get(task); assert.equal(task.state, 'failed');
  assert.equal(task.status_detail.category, 'model_or_execution_error');
  assert.equal(task.run.failure.request_matched, false);
  f.native.emit('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'private details' } } });
  task = await f.get(task); assert.equal(task.state, 'needs_human');
  assert.equal(task.status_detail.native_end_reason, 'error');
  assert.equal(JSON.stringify(task).includes('private details'), false);
});
