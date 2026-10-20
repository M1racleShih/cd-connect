import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { listenHealth } from '../src/server.js';
import { apply, runtimeIdentity } from '../src/plugin.js';
import { connectHealth } from '../src/connection.js';
import { TOOL_NAMES } from '../src/protocol.js';

const token = 'a'.repeat(64);
const fixtureHealth = { instance_id: 'test-instance', bridge: { phase: 0 } };

test('real MCP handshake, bounded tool list, health call and unknown tool rejection', async t => {
  const endpoint = await listenHealth({ port: 0, token, readHealth: () => fixtureHealth });
  t.after(() => endpoint.close());
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name), ['bridge_health']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const result = await client.callTool({ name: 'bridge_health', arguments: {} });
  assert.deepEqual(result.structuredContent, fixtureHealth);
  assert.equal((await client.callTool({ name: 'task_submit', arguments: {} })).isError, true);
});

test('reject unauthenticated, browser, wrong-host, oversized and malformed requests', async t => {
  const endpoint = await listenHealth({ port: 0, token, readHealth: () => fixtureHealth });
  t.after(() => endpoint.close());
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (const [extra, body, expected] of [
    [{ Authorization: '' }, '{}', 401],
    [{ Authorization: 'Bearer wrong' }, '{}', 401],
    [{ Origin: 'http://example.com' }, '{}', 403],
    [{}, 'x'.repeat(17000), 413],
    [{}, '{bad', 400],
  ]) {
    const result = await fetch(endpoint.url, { method: 'POST', headers: { ...headers, ...extra }, body });
    assert.equal(result.status, expected);
  }
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = request(endpoint.url, { method: 'POST', headers: { ...headers, Host: 'example.com' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fetch(endpoint.url, { headers })).status, 405);
  assert.equal((await fetch(endpoint.url + '/other', { headers })).status, 404);
  await assert.rejects(listenHealth({ port: Number(new URL(endpoint.url).port), token, readHealth: () => fixtureHealth }), { code: 'EADDRINUSE' });
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cd-connect-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'runtime/lib'), { recursive: true });
  await mkdir(join(dir, 'profile'));
  await writeFile(join(dir, 'runtime/lib/index.js'), '// fixture runtime');
  let effect;
  const ctx = {
    profileContext: { name: 'desktop', dir: join(dir, 'profile'), home: dir, installAnchor: join(dir, 'runtime/package.json') },
    pluginPackages: { packageOf: (name, parent) => {
      assert.equal(name, '@deepseek-ai/dsh-app-boot');
      assert.equal(parent, new URL('file://' + join(dir, 'runtime/package.json')).href);
      return { version: '0.2.1-rc.2', dir: join(dir, 'runtime') };
    } },
    get: name => ['sessionController', 'agents', 'sessions', 'approval'].includes(name) ? {} : undefined,
    on: () => () => {},
    effect: fn => { effect = fn; },
    logger: () => ({ info() {} }),
  };
  return { dir, ctx, run: () => effect() };
}

test('plugin reports host facts, rotates identity, forwards through stdio and cleans up', async t => {
  const { dir, ctx, run } = await fixture(t);
  const identity = await runtimeIdentity(ctx);
  assert.equal(identity.host_pid, process.pid);
  assert.equal(identity.dsh.version, '0.2.1-rc.2');
  assert.match(identity.dsh.app_boot_sha256, /^[a-f0-9]{64}$/);
  assert.equal((await runtimeIdentity(ctx)).instance_id, identity.instance_id);
  assert.notEqual((await runtimeIdentity(ctx)).runtime_id, identity.runtime_id);
  await apply(ctx, { port: 0 });
  const dispose = await run();
  t.after(dispose);
  const stateDir = join(dir, 'cd-connect');
  const connectionPath = join(stateDir, 'connection.json');
  assert.equal((await stat(connectionPath)).mode & 0o777, 0o600);
  const client = await connectHealth(stateDir);
  const result = await client.callTool({ name: 'bridge_health', arguments: {} });
  await client.close();
  assert.equal(result.structuredContent.host_pid, process.pid);
  assert.equal(result.structuredContent.capabilities.native_services.user_approval, true);
  assert.deepEqual(result.structuredContent.capabilities.tools, TOOL_NAMES);
  assert.equal(result.structuredContent.bridge.phase, 3);
  const stdio = new Client({ name: 'stdio-test', version: '1' });
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/stdio.js')], env: { CD_CONNECT_STATE_DIR: stateDir } }));
  try {
    const forwarded = await stdio.callTool({ name: 'bridge_health', arguments: {} });
    assert.equal(forwarded.structuredContent.runtime_id, result.structuredContent.runtime_id);
  } finally { await stdio.close(); }
  const data = JSON.parse(await readFile(connectionPath, 'utf8'));
  assert.equal(JSON.stringify(result).includes(data.token), false);
  await chmod(connectionPath, 0o644);
  await assert.rejects(connectHealth(stateDir), /permissions/);
  await dispose();
  await assert.rejects(stat(connectionPath), { code: 'ENOENT' });
  await assert.rejects(fetch(data.url));
});

test('refuse non-desktop profiles and missing runtime versions', async t => {
  const { ctx } = await fixture(t);
  ctx.profileContext.name = 'headless';
  await assert.rejects(runtimeIdentity(ctx), /desktop/);
  ctx.profileContext.name = 'desktop';
  ctx.pluginPackages.packageOf = () => undefined;
  await assert.rejects(runtimeIdentity(ctx), /version/);
});
