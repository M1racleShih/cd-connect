/** Native Cordis plugin. Runs inside the Desktop Host, never starts a second Host. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { BRIDGE_VERSION, listenHealth } from './server.js';
import { nativeAdapter } from './native.js';
import { TaskManager } from './tasks.js';
import { TOOL_NAMES } from './protocol.js';

export const name = 'cd-connect';
export const inject = ['profileContext', 'pluginPackages', 'sessionController', 'agents', 'sessions', 'sessionQuery'];

/** Report launcher-owned facts and an actual runtime artifact digest, without configuration contents. */
export async function runtimeIdentity(ctx) {
  const profile = ctx.profileContext;
  if (profile.name !== 'desktop') throw new Error('cd-connect requires the native desktop profile');
  const runtime = ctx.pluginPackages.packageOf('@deepseek-ai/dsh-app-boot', pathToFileURL(profile.installAnchor).href);
  if (!runtime?.version) throw new Error('Cannot determine the running DSH version');
  const artifact = await readFile(join(runtime.dir, 'lib/index.js'));
  const profilePath = await realpath(profile.dir);
  return {
    instance_id: createHash('sha256').update(`${hostname()}\0${profilePath}`).digest('hex'),
    runtime_id: randomUUID(),
    host_pid: process.pid,
    host_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    profile: profile.name,
    dsh: { version: runtime.version, app_boot_sha256: createHash('sha256').update(artifact).digest('hex') },
    bridge: { version: BRIDGE_VERSION, phase: 3, transport: 'streamable-http', bind: '127.0.0.1', authentication: 'bearer' },
  };
}

/** Own all network and discovery resources through the native plugin lifecycle. */
export async function apply(ctx, config = {}) {
  await ctx.effect(async () => {
    const identity = await runtimeIdentity(ctx);
    const stateDir = join(ctx.profileContext.home, 'cd-connect');
    const token = randomBytes(32).toString('hex');
    const tasks = new TaskManager(nativeAdapter(ctx), identity, { stateDir: join(stateDir, 'ledger') });
    let listener;
    try { listener = await listenHealth({ port: config.port ?? 48763, token, tasks, readHealth: () => ({
      ...identity,
      checked_at: new Date().toISOString(),
      storage: { healthy: !tasks.storageError, error: tasks.storageError ?? null },
      capabilities: {
        tools: TOOL_NAMES,
        task_execution: true,
        task_storage: 'durable_snapshot_v1',
        manual_recovery: true,
        approval_display: true,
        run_scoped_cancel: true,
        native_services: {
          session_controller: !!ctx.get('sessionController'),
          agents: !!ctx.get('agents'),
          sessions: !!ctx.get('sessions'),
          session_query: !!ctx.get('sessionQuery'),
          user_approval: !!ctx.get('approval'),
        },
      },
    }) }); } catch (error) { await tasks.close(); throw error; }
    const connectionPath = join(stateDir, 'connection.json');
    const temporaryPath = join(stateDir, `connection-${identity.runtime_id}.tmp`);
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, JSON.stringify({ url: listener.url, token, runtime_id: identity.runtime_id }), { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, connectionPath);
    } catch (error) {
      await tasks.close();
      await listener.close();
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    ctx.logger('cd-connect').info(`Phase 3 task bridge listening on ${listener.url}`);
    return async () => {
      await tasks.close();
      // Remove discovery before releasing the port to a successor plugin.
      try { await unlink(connectionPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      finally { await listener.close(); }
    };
  }, 'cd-connect health listener');
}
