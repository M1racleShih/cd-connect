/** Loopback-only authenticated MCP transport. Task state lives in the plugin. */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TASK_INSTRUCTIONS, TASK_TOOLS, toolResult } from './protocol.js';

export const BRIDGE_VERSION = '0.5.0';

/** A health-only server remains available for transport fixtures. */
export function healthServer(readHealth, tasks, availableTools = Object.keys(TASK_TOOLS)) {
  const server = new McpServer({ name: 'cd-connect', version: BRIDGE_VERSION }, {
    instructions: tasks ? TASK_INSTRUCTIONS : 'Call bridge_health to identify the connected DSH Host. No task execution tools are available.',
  });
  server.registerTool('bridge_health', {
    description: 'Use this to check the connected DSH desktop instance, runtime version and available bridge capabilities. Reads no accounts or sessions.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const health = await readHealth();
    return toolResult(health);
  });
  if (tasks) for (const [name, definition] of Object.entries(TASK_TOOLS)) {
    if (!availableTools.includes(name)) continue;
    const readOnly = ['task_get', 'task_wait', 'task_evidence'].includes(name);
    server.registerTool(name, {
      description: definition.description, inputSchema: definition.schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly },
    }, async (args, extra) => {
      try {
        const result = await tasks.call(name, args, extra.signal);
        return result?.content ? result : toolResult(result);
      } catch (error) {
        // Never expose native stacks/configuration or provider errors over MCP.
        const code = /^[a-z0-9_]+$/.test(error.message) ? error.message : 'task_operation_failed_check_DSH';
        return { isError: true, ...toolResult({ error: code }) };
      }
    });
  }
  return server;
}

function authorized(header, token) {
  const supplied = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Start a listener owned by the plugin; closing it also closes active connections. */
export async function listenHealth({ port = 48763, token, readHealth, tasks }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid bridge port');
  if (typeof token !== 'string' || token.length < 32) throw new Error('Bridge token must contain at least 32 characters');
  const listener = createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${listener.address().port}` || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (!authorized(req.headers.authorization, token)) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    // Bound task specifications and malformed input before handing them to the SDK.
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400).end(); return; }
      const server = healthServer(readHealth, tasks);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });
  listener.requestTimeout = 10000;
  listener.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  let closing;
  return {
    url: `http://127.0.0.1:${listener.address().port}/mcp`,
    close: () => closing ??= new Promise((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
      listener.closeAllConnections();
    }),
  };
}
