#!/usr/bin/env node
/** Local MCP adapter; forwards only the tools advertised by the native Host. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { healthServer } from './server.js';
import { connectHealth } from './connection.js';

const probe = await connectHealth();
let availableTools;
try { availableTools = (await probe.listTools()).tools.map(tool => tool.name); }
finally { await probe.close(); }

async function forward(name, args, signal) {
  const client = await connectHealth();
  try {
    return await client.callTool({ name, arguments: args }, undefined, { signal });
  } finally { await client.close(); }
}
const server = healthServer(async () => {
  const result = await forward('bridge_health', {});
  if (result.isError || !result.structuredContent) throw new Error('Native health call failed');
  return result.structuredContent;
}, availableTools.includes('task_submit') ? { call: forward } : undefined, availableTools);
await server.connect(new StdioServerTransport());
