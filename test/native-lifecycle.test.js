import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from '../src/plugin.js';
import { connectHealth } from '../src/connection.js';

// Optional integration check against the actual native Cordis lifecycle.
const source = process.env.CD_CONNECT_DSH_SOURCE;
test('native cold startup waits for session services before activating the bridge', { skip: !source, timeout: 5000 }, async t => {
  const { Context } = await import(pathToFileURL(join(source, 'vendor/cordis/lib/index.js')).href);
  const dir = await mkdtemp(join(tmpdir(), 'cd-connect-cold-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'lib'));
  await writeFile(join(dir, 'lib/index.js'), '// disposable runtime fixture');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('profileContext', { name: 'desktop', dir, home: dir, installAnchor: join(dir, 'package.json') });
  ctx.provide('pluginPackages', { packageOf: () => ({ dir, version: '0.2.1-rc.2' }) });
  const loading = ctx.plugin(plugin, { port: 0 });
  await new Promise(resolve => setImmediate(resolve));
  const discovery = join(dir, 'cd-connect/connection.json');
  await assert.rejects(stat(discovery), { code: 'ENOENT' });
  // Desktop assembles these services after the external bundle was discovered.
  ctx.provide('agents', {});
  ctx.provide('sessions', {});
  ctx.provide('sessionController', {});
  ctx.provide('sessionQuery', {});
  await loading;
  const client = await connectHealth(join(dir, 'cd-connect'));
  try {
    const health = (await client.callTool({ name: 'bridge_health', arguments: {} })).structuredContent;
    assert.equal(health.bridge.phase, 3);
    assert.equal(health.capabilities.task_execution, true);
    assert.equal((await client.listTools()).tools.length, 9);
  } finally { await client.close(); }
  await loading.dispose();
  await assert.rejects(stat(discovery), { code: 'ENOENT' });
});

test('native adapter reads actual JSONL logs through the cold Session query service after disposal', { skip: !source, timeout: 10000 }, async t => {
  const load = file => import(pathToFileURL(join(source, file)).href);
  const [{ Context }, { default: SessionStore, SESSION_FORMAT_VERSION }, persistence, { SessionQueryEngine }, { nativeAdapter }] = await Promise.all([
    load('vendor/cordis/lib/index.js'), load('packages/core/session/lib/index.js'),
    load('packages/session/session-persistence-jsonl/lib/index.js'), load('packages/session-query/session-query/lib/index.js'),
    import('../src/native.js'),
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'cd-connect-native-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const make = async () => {
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    await ctx.plugin(persistence, { root: dir, compression: 'none' });
    await ctx.plugin(SessionQueryEngine);
    ctx.provide('agents', { get: () => undefined });
    ctx.provide('sessionController', {});
    return ctx;
  };
  let ctx = await make();
  const header = { version: SESSION_FORMAT_VERSION, id: 'native-cold-fixture', createdAt: 1, isSeeded: false, cwd: dir };
  const handle = await ctx.get('sessionPersistence').create(header);
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { turn: 1, id: 'native-user', role: 'user', content: [{ type: 'text', text: 'fixture only' }], source: { kind: 'user', rpcId: 'cd-connect:durable-request' } } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  await handle.append(events); await handle.flush(); await handle.close();
  await ctx.fiber.dispose();
  ctx = await make();
  t.after(() => ctx.fiber.dispose());
  const log = await nativeAdapter(ctx).read(header.id);
  assert.equal(log.source, 'prepared'); assert.equal(log.cursor, 2);
  assert.equal(log.cwd, dir); assert.deepEqual(log.events, events);
  assert.equal(log.events[1].data.source.rpcId, 'cd-connect:durable-request');
  assert.equal(ctx.get('sessions').get(header.id), undefined, 'read does not activate a native session');
});

test('actual native ApprovalService emits turnless audit, waits before executing, and fails closed on rejection', { skip: !source, timeout: 5000 }, async t => {
  const load = file => import(pathToFileURL(join(source, file)).href);
  const [{ Context }, { default: SessionStore }, { default: ApprovalService }] = await Promise.all([
    load('vendor/cordis/lib/index.js'), load('packages/core/session/lib/index.js'), load('packages/interaction/user-approval/lib/index.js'),
  ]);
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore); await ctx.plugin(ApprovalService);
  const session = ctx.sessions.create('native-approval-fixture');
  session.append('turn/start', { turn: 1 });
  const agent = { session };
  let answer;
  ctx.on('approval/request', () => new Promise(resolve => { answer = resolve; }));
  for (const outcome of ['allowed-once', 'rejected']) {
    let executed = false;
    let settled = false;
    const operation = ctx.approval.request({ agent, toolName: 'fixture-only', callId: outcome, reason: 'isolated native gate test' }).then(result => {
      if (result === 'allowed-once') executed = true;
      settled = true; return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    const asked = session.snapshotEvents().at(-1);
    assert.equal(asked.type, 'approval/asked'); assert.equal(asked.data.turn, undefined);
    assert.equal(settled, false); assert.equal(executed, false);
    answer(outcome); assert.equal(await operation, outcome);
    assert.equal(executed, outcome === 'allowed-once');
    const decided = session.snapshotEvents().at(-1);
    assert.equal(decided.type, 'approval/decided'); assert.equal(decided.data.id, asked.data.id);
  }
});

test('actual native AgentLoop accepts guarded text continuation and confirms cancellation in its owned turn', { skip: !source, timeout: 10000 }, async t => {
  const load = file => import(pathToFileURL(join(source, file)).href);
  const [{ Context }, llm, { default: SessionStore }, { default: Projection }, { default: SystemPrompt },
    { default: Tools }, { default: Agents }, { default: Loop }, { nativeAdapter }] = await Promise.all([
    load('vendor/cordis/lib/index.js'), load('packages/llm/llm/lib/index.js'), load('packages/core/session/lib/index.js'),
    load('packages/session/session-projection/lib/index.js'), load('packages/core/system-prompt/lib/index.js'),
    load('packages/core/tools/lib/index.js'), load('packages/core/agent/lib/index.js'), load('packages/core/agent-loop/lib/index.js'), import('../src/native.js'),
  ]);
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  for (const plugin of [llm.default, SessionStore, Projection, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin);
  await ctx.plugin(Loop, { agents: [] });
  class FixtureModel extends llm.LlmAdapter {
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
    async *stream(options) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'fixture' };
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(new Error('aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureModel());
  const agent = await ctx.agentLoop.create('native-owned-control', { provider: 'fixture', model: 'fixture' });
  const controller = { resolveAgent: async () => ({ agent }), cancel: ({ sessionId }) => {
    assert.equal(sessionId, agent.id); agent.cancel({ kind: 'user' }, { keepInbox: true }); return { accepted: true };
  } };
  const adapter = nativeAdapter({ get: name => name === 'sessionController' ? controller : ctx.get(name) });
  const started = new Promise(resolve => {
    ctx.on('session/event', (session, event) => { if (session.id === agent.id && event.type === 'user/message') resolve(); });
  });
  assert.equal((await adapter.continue(agent.id, 'owned-native-request', 'isolated text', { cwd: agent.session.header.cwd, cursor: agent.session.seq - 1 })).accepted, true);
  await started;
  const events = agent.session.snapshotEvents();
  const start = events.findLast(e => e.type === 'turn/start');
  assert.equal(events.find(e => e.type === 'user/message').data.source.rpcId, 'owned-native-request');
  const receipt = adapter.cancel(agent.id, { cwd: agent.session.header.cwd, cursor: agent.session.seq - 1, turn: start.data.turn, request_id: 'owned-native-request' });
  assert.equal(receipt.accepted, true);
  await agent.whenIdle();
  assert.equal(agent.status, 'idle'); assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'aborted');
  assert.throws(() => adapter.cancel(agent.id, { cwd: agent.session.header.cwd, cursor: agent.session.seq - 1, turn: start.data.turn, request_id: 'owned-native-request' }), /native_run_changed/);
});
