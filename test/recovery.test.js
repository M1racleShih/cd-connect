import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskManager } from '../src/tasks.js';
import { TaskStore, canonical, sha256 } from '../src/storage.js';
import { simulatedNative, taskSpec } from './support/native.js';

const evidenceRecords = [];
const summarize = data => ({
  tasks: data.tasks.map(t => ({ task_id: t.id, revision: t.revision, state: t.state, reason: t.reason,
    creation: t.creation, session_id: t.session_id, native_cursor: t.native_cursor,
    run: t.run && { id: t.run.id, request_id: t.run.request_id, stage: t.run.stage, text_sha256: t.run.text_sha256,
      receipt: t.run.receipt, reconciled_acceptance: t.run.reconciled_acceptance, execution_completed: t.run.execution_completed },
    recovery: t.recovery, artifacts: t.artifacts, reviews: t.reviews, events: t.events })),
  requests: data.requests.map(r => ({ id: r.id, hash: r.hash, task_id: r.task_id, status: r.status, error: r.error })),
});
after(async () => {
  if (process.env.CD_CONNECT_TEST_EVIDENCE_DIR) {
    await mkdir(process.env.CD_CONNECT_TEST_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.CD_CONNECT_TEST_EVIDENCE_DIR, 'recovery-matrix.json'), JSON.stringify({
      verification: 'isolated-process-crashes-and-native-log-simulator', real_desktop_restart: false,
      records: evidenceRecords,
    }, null, 2) + '\n', { mode: 0o600 });
  }
});

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cd-connect-recovery-'));
  const workspace = join(dir, 'workspace'); await mkdir(workspace);
  const stateDir = join(dir, 'ledger');
  const identity = { instance_id: 'crash-instance', runtime_id: 'first-runtime' };
  const native = simulatedNative(dir, workspace, options);
  let manager;
  const open = runtime => {
    manager = new TaskManager(native, { ...identity, runtime_id: runtime }, { stateDir });
    return manager;
  };
  t.after(async () => {
    if (process.env.CD_CONNECT_TEST_EVIDENCE_DIR) {
      const envelope = JSON.parse(await readFile(join(stateDir, 'tasks.json'), 'utf8'));
      evidenceRecords.push({ test: t.name, checksum_valid: envelope.checksum === sha256(canonical(envelope.data)),
        final_ledger: summarize(envelope.data), native: { creates: native.data.creates, prompts: native.data.prompts,
          effects: native.data.effects, queue: native.data.queue, events: native.data.events } });
    }
    await manager?.close(); await rm(dir, { recursive: true, force: true });
  });
  const recover = (task, action = 'inspect', id = `recover-${task.revision}`) => manager.call('task_recover', {
    task_id: task.task_id, expected_revision: task.revision, request_id: id, action,
  });
  const get = task => manager.call('task_get', { task_id: task.task_id });
  const review = async (task, decision = 'accepted', id = 'review') => {
    const page = await manager.call('task_evidence', { task_id: task.task_id, run_id: task.run.id });
    return manager.call('task_review', { task_id: task.task_id, run_id: task.run.id,
      request_id: id, expected_revision: task.revision, decision, comment: 'Verified current artifacts', evidence_ids: page.items.map(e => e.id) });
  };
  return { dir, workspace, stateDir, native, open, get, recover, review, get manager() { return manager; } };
}

for (const crash of ['create-prepared', 'create-attempted', 'create-receipt-lost', 'create-recorded', 'prompt-prepared', 'prompt-attempted', 'prompt-receipt-lost', 'prompt-receipt-uncommitted', 'prompt-recorded', 'completed']) {
  test(`process crash: ${crash}; persisted intent and native log determine recovery without replay`, async t => {
    const f = await fixture(t);
    const child = spawnSync(process.execPath, [resolve('scripts/fault-worker.js'), f.dir, f.workspace, crash], { encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr);
    f.native.reload(); f.open('recovered-runtime');
    const disk = JSON.parse(await readFile(join(f.stateDir, 'tasks.json'), 'utf8')).data;
    if (process.env.CD_CONNECT_TEST_EVIDENCE_DIR) evidenceRecords.push({ test: t.name, crash_exit: child.status, before_recovery: summarize(disk) });
    let task = await f.get({ task_id: disk.tasks[0].id });
    assert.equal(task.state, 'needs_recovery');
    const calls = f.native.data.prompts;
    await assert.rejects(f.manager.call('task_continue', { task_id: task.task_id, run_id: task.run?.id ?? 'no-run', expected_revision: 1, request_id: 'blocked', instruction: 'Continue' }), /recovery_required/);
    task = await f.recover(task);
    assert.equal(f.native.data.prompts, calls, 'inspection never replays a prompt');
    if (['create-prepared', 'create-recorded', 'prompt-prepared'].includes(crash)) {
      task = await f.recover(task, 'dispatch_prepared');
      assert.equal(task.state, 'running'); assert.equal(f.native.data.prompts, 1);
      f.native.begin(); f.native.finish(); task = await f.get(task);
      assert.equal(task.state, 'awaiting_review');
      assert.equal((await f.review(task)).state, 'accepted');
      assert.equal(f.native.data.effects, 1);
    } else if (['prompt-receipt-lost', 'prompt-receipt-uncommitted', 'prompt-recorded'].includes(crash)) {
      assert.equal(task.state, 'running'); assert.equal(task.run.reconciled_acceptance.queued, true);
      f.native.begin(); f.native.finish(); task = await f.get(task);
      assert.equal((await f.review(task)).state, 'accepted');
      assert.equal(f.native.data.effects, 1); assert.equal(f.native.data.prompts, 1);
    } else if (crash === 'completed') {
      assert.equal(task.state, 'awaiting_review'); assert.equal(task.artifacts.valid, true);
      assert.equal((await f.review(task)).state, 'accepted');
      assert.equal(f.native.data.effects, 1);
    } else {
      assert.ok(['needs_human', 'needs_recovery'].includes(task.state));
      const before = f.native.data.prompts;
      task = await f.recover(task, 'dispatch_prepared');
      assert.equal(f.native.data.prompts, before);
      assert.notEqual(task.state, 'accepted');
    }
    const durable = JSON.parse(await readFile(join(f.stateDir, 'tasks.json'), 'utf8')).data;
    assert.ok(durable.requests.every(r => r.hash));
    assert.equal(durable.tasks[0].creation.requested_session_id, disk.tasks[0].creation.requested_session_id);
  });
}

test('durable request identity, concurrent retries, revisions, reviews and same-session continuation survive reload', async t => {
  const f = await fixture(t); f.open('one');
  const spec = taskSpec(f.workspace);
  const [a, b] = await Promise.all([f.manager.call('task_submit', spec), f.manager.call('task_submit', spec)]);
  assert.deepEqual(a, b); assert.equal(f.native.data.creates, 1); assert.equal(f.native.data.prompts, 1);
  f.native.begin(); f.native.finish();
  let task = await f.get(a); task = await f.review(task, 'changes_requested');
  await f.manager.close(); f.open('two');
  assert.deepEqual(await f.manager.call('task_submit', spec), a);
  await assert.rejects(f.manager.call('task_submit', { ...spec, goal: 'Other content' }), /content_conflict/);
  task = await f.get(task); task = await f.recover(task);
  await assert.rejects(f.manager.call('task_continue', { task_id: task.task_id, run_id: task.run?.id, expected_revision: 1, request_id: 'stale', instruction: 'Change goal' }), /revision_conflict/);
  const args = { task_id: task.task_id, run_id: task.run?.id, expected_revision: task.revision, request_id: 'continue', instruction: 'Reverify result.txt' };
  const [c, d] = await Promise.all([f.manager.call('task_continue', args), f.manager.call('task_continue', args)]);
  assert.deepEqual(c, d); assert.equal(c.session_id, a.session_id); assert.equal(f.native.data.prompts, 2);
  f.native.begin(); f.native.finish(); task = await f.get(c); task = await f.review(task, 'accepted', 'final-review');
  await f.manager.close(); f.open('three'); task = await f.get(task); task = await f.recover(task);
  assert.equal(task.state, 'accepted'); assert.equal(task.reviews.length, 2);
  assert.equal(f.native.data.effects, 2);
});

test('offline completion replays durable evidence but cannot invent a completion artifact witness', async t => {
  const f = await fixture(t); f.open('one');
  let task = await f.manager.call('task_submit', taskSpec(f.workspace));
  await f.manager.close();
  f.native.begin(false); f.native.finish(false);
  f.open('two'); task = await f.recover(await f.get(task));
  assert.equal(task.state, 'awaiting_review'); assert.equal(task.artifacts.valid, false);
  await assert.rejects(f.review(task), /artifact_evidence_invalid/);
  task = await f.review(task, 'changes_requested', 'rework');
  assert.equal(task.state, 'changes_requested'); assert.equal(f.native.data.effects, 1);
});

test('DSH restart: a completed cold log can be reviewed and continued in the saved session; interrupted work needs inspection', async t => {
  const options = {}; const f = await fixture(t, options); f.open('one');
  let task = await f.manager.call('task_submit', taskSpec(f.workspace));
  f.native.begin(); f.native.finish(); task = await f.get(task);
  await f.manager.close(); options.cold = true; f.open('two');
  task = await f.recover(await f.get(task));
  task = await f.review(task, 'changes_requested');
  task = await f.manager.call('task_continue', { task_id: task.task_id, run_id: task.run?.id, expected_revision: task.revision, request_id: 'cold-continue', instruction: 'Reverify' });
  assert.equal(task.session_id, f.native.data.session); assert.equal(f.native.data.prompts, 2);
  options.cold = false; f.native.begin(); await f.manager.close(); options.cold = true; f.open('three');
  task = await f.recover(await f.get(task));
  assert.equal(task.state, 'needs_human'); assert.match(task.reason, /interrupted/);
  assert.equal(f.native.data.prompts, 2);
});

test('external workspace edits invalidate evidence before review and after acceptance; overlapping paths stay locked', async t => {
  const f = await fixture(t); f.open('one');
  let task = await f.manager.call('task_submit', taskSpec(f.workspace));
  await mkdir(join(f.workspace, 'nested'));
  await assert.rejects(f.manager.call('task_submit', { ...taskSpec(join(f.workspace, 'nested')), request_id: 'nested' }), /workspace_has_unaccepted/);
  await symlink(f.workspace, join(f.dir, 'alias'));
  await assert.rejects(f.manager.call('task_submit', { ...taskSpec(join(f.dir, 'alias')), request_id: 'alias' }), /workspace_has_unaccepted/);
  f.native.begin(); f.native.finish(); task = await f.get(task);
  await writeFile(join(f.workspace, 'result.txt'), 'external write');
  await assert.rejects(f.review(task), /artifact_evidence_invalid/);
  task = await f.get(task); assert.equal(task.artifacts.valid, false);
  task = await f.review(task, 'changes_requested', 'rework');
  task = await f.manager.call('task_continue', { task_id: task.task_id, run_id: task.run?.id, expected_revision: task.revision, request_id: 'continue', instruction: 'Recheck' });
  f.native.begin(); f.native.finish(); task = await f.get(task); task = await f.review(task, 'accepted', 'accepted');
  await writeFile(join(f.workspace, 'result.txt'), 'another executor');
  task = await f.get(task); assert.equal(task.state, 'needs_human'); assert.equal(task.reviews.at(-1).evidence_valid, false);
});

test('duplicate native events are ignored, conflicting events and invalid native cursors stop acceptance', async t => {
  const f = await fixture(t); f.open('one');
  let task = await f.manager.call('task_submit', taskSpec(f.workspace));
  f.native.begin(); const e = f.native.emit('assistant/message', { turn: 1, message: { content: [] } });
  f.native.repeat(e); task = await f.get(task); assert.equal(task.evidence_cursor, 1);
  f.native.repeat({ ...e, data: { ...e.data, message: { content: [{ type: 'text', text: 'changed' }] } } });
  assert.equal((await f.get(task)).state, 'needs_human');
  await f.manager.close(); f.open('two');
  f.native.data.events.pop();
  task = await f.recover(await f.get(task));
  assert.match(task.reason, /cursor_invalid/); assert.equal(f.native.data.prompts, 1);
});

test('storage failure fences dispatch, durable corrupt data fails closed, and a live storage owner cannot be replaced', async t => {
  const f = await fixture(t); f.open('one');
  assert.throws(() => new TaskStore(f.stateDir, 'crash-instance'), /already_owned/);
  const save = f.manager.store.save.bind(f.manager.store);
  f.manager.store.save = data => { if (data.tasks[0]?.creation.stage === 'attempted') throw new Error('storage_write_failed_reload_and_reconcile'); save(data); };
  await assert.rejects(f.manager.call('task_submit', taskSpec(f.workspace)), /storage_write_failed/);
  assert.equal(f.native.data.creates, 0); assert.equal(f.native.data.prompts, 0);
  await assert.rejects(f.manager.call('task_get', { task_id: [...f.manager.tasks.keys()][0] }), /storage_write_failed/);
  await f.manager.close();
  const path = join(f.stateDir, 'tasks.json');
  const contents = JSON.parse(await readFile(path, 'utf8')); contents.data.tasks[0].spec.goal = 'tampered';
  await writeFile(path, JSON.stringify(contents));
  assert.throws(() => f.open('two'), /storage_corrupt/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a request saved before task allocation can be retried safely; concurrent different submissions cannot share a workspace', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, [resolve('scripts/fault-worker.js'), f.dir, f.workspace, 'request-only'], { encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  f.open('retry');
  const [a, b] = await Promise.all([f.manager.call('task_submit', taskSpec(f.workspace)), f.manager.call('task_submit', taskSpec(f.workspace))]);
  assert.equal(a.task_id, b.task_id); assert.equal(f.native.data.prompts, 1);
  const outcomes = await Promise.allSettled(['other-1', 'other-2'].map(request_id => f.manager.call('task_submit', { ...taskSpec(f.workspace), request_id })));
  assert.ok(outcomes.every(r => r.status === 'rejected' && /workspace_has_unaccepted/.test(r.reason.message)));
  assert.equal(f.native.data.creates, 1);
});

test('receipt-write and evidence-write failures are visible and recover from native logs without another prompt', async t => {
  for (const at of ['receipt', 'evidence']) {
    const f = await fixture(t); f.open('one');
    const save = f.manager.store.save.bind(f.manager.store);
    f.manager.store.save = data => {
      if ((at === 'receipt' && data.tasks[0]?.run?.receipt) || (at === 'evidence' && data.tasks[0]?.evidence.length)) throw new Error('storage_write_failed_reload_and_reconcile');
      save(data);
    };
    let task;
    if (at === 'receipt') {
      await assert.rejects(f.manager.call('task_submit', taskSpec(f.workspace)), /storage_write_failed/);
      task = { task_id: [...f.manager.tasks.keys()][0] };
    } else {
      task = await f.manager.call('task_submit', taskSpec(f.workspace));
      f.native.begin(); f.native.finish();
      await assert.rejects(f.get(task), /storage_or_observation_failed/);
    }
    await f.manager.close(); f.open('two');
    task = await f.get(task); task = await f.recover(task);
    assert.equal(f.native.data.prompts, 1);
    assert.ok(['running', 'awaiting_review'].includes(task.state));
    if (at === 'evidence') { assert.equal(task.artifacts.valid, false); assert.equal(task.evidence_cursor, 2); }
  }
});

test('actual atomic snapshot replacement failure fences the store and preserves the previous snapshot', async t => {
  const f = await fixture(t); f.open('one');
  const store = f.manager.store;
  const before = await readFile(store.path, 'utf8');
  const path = store.path; store.path = f.dir; // rename cannot replace this nonempty directory
  assert.throws(() => store.save({ version: 1 }), /storage_write_failed/);
  store.path = path;
  assert.equal(await readFile(path, 'utf8'), before);
  assert.throws(() => store.save(store.data), /storage_unavailable/);
});

test('gaps in live native events are reconciled from logs; a snapshot overtaken during recovery requires a fresh inspection', async t => {
  const f = await fixture(t); f.open('one');
  let task = await f.manager.call('task_submit', taskSpec(f.workspace));
  f.native.begin();
  f.native.emit('assistant/message', { turn: 1, message: { content: [] } }, false);
  f.native.emit('assistant/message', { turn: 1, message: { content: [] } });
  task = await f.get(task); assert.equal(task.state, 'needs_recovery');
  task = await f.recover(task); assert.equal(task.state, 'running'); assert.equal(task.evidence_cursor, 2);
  await f.manager.close(); f.open('two');
  const read = f.native.read;
  f.native.read = async session => {
    const log = await read(session);
    f.native.emit('assistant/message', { turn: 1, message: { content: [] } });
    return log;
  };
  task = await f.recover(await f.get(task)); assert.equal(task.state, 'needs_recovery');
  assert.match(task.reason, /advanced_during_recovery/);
  f.native.read = read;
  task = await f.recover(task); assert.equal(task.state, 'running'); assert.equal(task.evidence_cursor, 3);
  f.native.finish(); task = await f.get(task); assert.equal(task.state, 'awaiting_review');
});

test('plugin disposal during native create saves its receipt but does not dispatch a new prompt', async t => {
  const f = await fixture(t); f.open('one');
  const create = f.native.create;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.native.create = async (...args) => { const receipt = await create(...args); entered(); await gate; return receipt; };
  const submitting = f.manager.call('task_submit', taskSpec(f.workspace));
  await started;
  const closed = f.manager.close(); release();
  await assert.rejects(submitting, /bridge_closed/); await closed;
  assert.equal(f.native.data.prompts, 0);
  f.open('two'); const task = await f.get({ task_id: [...f.manager.tasks.keys()][0] });
  assert.ok(task.session_id); assert.equal(task.run, null);
});

test('an older accepted task invalidated by a later task does not reclaim the later task workspace lock', async t => {
  const f = await fixture(t); f.open('one');
  let old = await f.manager.call('task_submit', taskSpec(f.workspace));
  f.native.begin(); f.native.finish(); old = await f.get(old); old = await f.review(old);
  assert.equal(old.workspace_claimed, false);
  let current = await f.manager.call('task_submit', { ...taskSpec(f.workspace), request_id: 'later-task' });
  f.native.begin(); f.native.finish();
  old = await f.get(old); assert.equal(old.artifacts.valid, false); assert.equal(old.workspace_claimed, false);
  current = await f.get(current); current = await f.review(current, 'changes_requested', 'later-rework');
  current = await f.manager.call('task_continue', { task_id: current.task_id, run_id: current.run?.id, expected_revision: current.revision, request_id: 'later-continue', instruction: 'Reverify' });
  assert.equal(current.workspace_claimed, true); assert.equal(f.native.data.prompts, 3);
});

test('phase 2 continuation records load and unchanged legacy retries retain their original result without redispatch', async t => {
  const f = await fixture(t); f.open('phase-2');
  let task = await f.manager.call('task_submit', taskSpec(f.workspace));
  f.native.begin(); f.native.finish(); task = await f.get(task);
  task = await f.review(task, 'changes_requested');
  const args = { task_id: task.task_id, run_id: task.run.id, expected_revision: task.revision, request_id: 'legacy-continue', instruction: 'Reverify result.txt' };
  const result = await f.manager.call('task_continue', args);
  await f.manager.close();
  const path = join(f.stateDir, 'tasks.json');
  const { data } = JSON.parse(await readFile(path, 'utf8'));
  const record = data.requests.find(r => r.id === args.request_id);
  delete record.request.args.run_id; record.hash = sha256(canonical(record.request));
  await writeFile(path, JSON.stringify({ checksum: sha256(canonical(data)), data }));
  f.open('phase-3');
  const legacy = { ...args }; delete legacy.run_id;
  assert.deepEqual(await f.manager.call('task_continue', legacy), result);
  assert.equal(f.native.data.prompts, 2);
});

test('recovery keeps native and bridge cursors separate across bounded wait pages and reload', async t => {
  const f = await fixture(t); f.open('one');
  let task = await f.manager.call('task_submit', taskSpec(f.workspace));
  f.native.begin();
  for (let i = 0; i < 80; i++) f.native.emit('step/start', { turn: 1, step: i });
  f.native.finish(); task = await f.get(task);
  await f.manager.close(); f.open('two');
  task = await f.recover(await f.get(task));
  assert.ok(task.recovery.cursor > task.event_cursor);
  const consume = async task => {
    let cursor = 0; const events = [];
    for (let pages = 0; pages < 100; pages++) {
      const page = await f.manager.call('task_wait', { task_id: task.task_id, cursor, limit: 1, timeout_ms: 0 });
      assert.ok(page.next_cursor <= page.task.event_cursor);
      assert.ok(page.items.every(e => e.cursor > cursor));
      events.push(...page.items); cursor = page.next_cursor;
      if (!page.has_more) break;
      assert.ok(pages < 99, 'paging must terminate');
    }
    assert.deepEqual(events.map(e => e.cursor), Array.from({ length: task.event_cursor }, (_, i) => i + 1));
    assert.equal(events.find(e => e.type === 'reconciled').native_cursor, task.recovery.cursor);
    const tail = await f.manager.call('task_wait', { task_id: task.task_id, cursor, timeout_ms: 0 });
    assert.deepEqual(tail.items, []); assert.equal(tail.has_more, false);
  };
  await consume(task);
  await f.manager.close(); f.open('three');
  await consume(await f.get(task));
});

test('old checksummed recovery events restore bridge order without changing native checkpoints or request identity', async t => {
  const f = await fixture(t); f.open('one');
  let task = await f.manager.call('task_submit', taskSpec(f.workspace));
  f.native.begin(); f.native.finish(); task = await f.get(task);
  await f.manager.close(); f.open('two');
  task = await f.recover(await f.get(task));
  task = await f.review(task, 'changes_requested');
  const nativeCalls = f.native.data.prompts;
  await f.manager.close();
  const path = join(f.stateDir, 'tasks.json'); const { data } = JSON.parse(await readFile(path, 'utf8'));
  const stored = data.tasks[0]; const event = stored.events.find(e => e.type === 'reconciled');
  const bridgeCursor = event.cursor;
  event.cursor = stored.recovery.cursor; delete event.native_cursor;
  const requests = canonical(data.requests); const hashes = canonical(stored.run.native_hashes);
  const nativeCursor = stored.native_cursor;
  await writeFile(path, JSON.stringify({ checksum: sha256(canonical(data)), data }));
  f.open('three');
  const page = await f.manager.call('task_wait', { task_id: task.task_id, cursor: bridgeCursor - 1, limit: 1, timeout_ms: 0 });
  assert.equal(page.items[0].cursor, bridgeCursor);
  assert.equal(page.items[0].native_cursor, stored.recovery.cursor);
  const migrated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(migrated.checksum, sha256(canonical(migrated.data)));
  assert.equal(canonical(migrated.data.requests), requests);
  assert.equal(canonical(migrated.data.tasks[0].run.native_hashes), hashes);
  assert.equal(migrated.data.tasks[0].native_cursor, nativeCursor);
  assert.equal(f.native.data.prompts, nativeCalls);
});

test('cursor migration refuses unrelated event-order damage instead of repairing arbitrary records', async t => {
  const f = await fixture(t); f.open('one');
  await f.manager.call('task_submit', taskSpec(f.workspace)); await f.manager.close();
  const path = join(f.stateDir, 'tasks.json'); const { data } = JSON.parse(await readFile(path, 'utf8'));
  data.tasks[0].events[0].cursor = 900;
  await writeFile(path, JSON.stringify({ checksum: sha256(canonical(data)), data }));
  assert.throws(() => f.open('two'), /storage_corrupt_or_wrong_instance/);
  assert.equal(f.native.data.prompts, 1);
});
