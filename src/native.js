import { randomUUID } from 'node:crypto';

/** Small adapter over the running Host's public services; no model/config writes. */
export function nativeAdapter(ctx) {
  const controller = ctx.get('sessionController');
  const agents = ctx.get('agents');
  const query = ctx.get('sessionQuery');
  if (!controller || !agents || !ctx.get('sessions')) throw new Error('Native task services are unavailable');
  const guard = (sessionId, expected, active) => {
    const agent = agents.get(sessionId);
    const events = agent?.session.snapshotEvents();
    if (!agent || agent.session.header.cwd !== expected.cwd ||
        agent.status !== (active ? 'running' : 'idle') ||
        events.length - 1 !== expected.cursor || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
      throw new Error('native_run_changed_control_rejected');
    }
    if (active) {
      const start = events.findLastIndex(e => e.type === 'turn/start');
      const tail = events.slice(start);
      const inputs = tail.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user');
      if (start < 0 || events[start].data.turn !== expected.turn || tail.some(e => e.type === 'turn/end') ||
          inputs.length !== 1 || inputs[0].data.source.rpcId !== expected.request_id) {
        throw new Error('native_run_changed_control_rejected');
      }
    }
    return agent;
  };
  return {
    // Check and act in the same synchronous Host stack. The controller's prompt
    // awaits admission, so continuation uses the public text-only Agent API.
    continue: async (sessionId, requestId, text, expected) => {
      const resolved = await controller.resolveAgent(sessionId);
      if (resolved.error) throw new Error('native_session_unavailable_control_rejected');
      const agent = guard(sessionId, expected, false);
      if (resolved.agent !== agent) throw new Error('native_run_changed_control_rejected');
      agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } });
      return { accepted: true };
    },
    cancel: (sessionId, expected) => {
      guard(sessionId, expected, true);
      return controller.cancel({ sessionId });
    },
    create: async (cwd, sessionId) => {
      // The native registry reuses canonical paths and preserves existing titles.
      // Creating with workspaceId lets DSH attach the session before returning.
      const workspace = await ctx.get('workspaceRegistry').create(cwd);
      return controller.create({ workspaceId: workspace.id, ...(sessionId ? { sessionId } : {}) });
    },
    prompt: (sessionId, requestId, text) => controller.prompt({
      sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }],
    }, new AbortController().signal),
    status: sessionId => {
      const agent = agents.get(sessionId);
      return agent ? { status: agent.status, cwd: agent.session.header.cwd } : { status: 'unavailable' };
    },
    read: async sessionId => {
      const observation = await query.observeSession(sessionId, { projectionMode: 'none' });
      try {
        const agent = agents.get(sessionId);
        const queued = agent ? [...agent.inbox.nextTurn, ...agent.inbox.nextStep] : [];
        return { cwd: observation.header.cwd, source: observation.source, cursor: observation.cursor,
          events: observation.events,
          queued_request_ids: queued.filter(m => m.source.kind === 'user').map(m => m.source.rpcId) };
      } finally { observation[Symbol.dispose](); }
    },
    subscribe: handler => {
      const dispose = [
        ctx.on('session/event', (session, event) => handler({ kind: 'event', session_id: session.id, event })),
        ctx.on('agent/status', ({ agent, status }) => handler({ kind: 'status', session_id: agent.id, status })),
        ctx.on('agent/error', ({ agent, turn }) => handler({ kind: 'error', session_id: agent.id, turn })),
        ctx.on('agent/disposed', ({ agent }) => handler({ kind: 'disposed', session_id: agent.id })),
      ];
      return () => { for (const stop of dispose) stop(); };
    },
  };
}
