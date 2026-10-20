/** Compare direct HTTP and local stdio calls against the same running Desktop Host. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectHealth } from '../src/connection.js';
import { TOOL_NAMES } from '../src/protocol.js';

const direct = await connectHealth();
const stdio = new Client({ name: 'cd-connect-native-verification', version: '0.1.0' });
try {
  await stdio.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/stdio.js', import.meta.url))],
    env: {
      ...(process.env.CD_CONNECT_STATE_DIR ? { CD_CONNECT_STATE_DIR: process.env.CD_CONNECT_STATE_DIR } : {}),
      ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
    },
  }));
  const { tools } = await stdio.listTools();
  assert.deepEqual(tools.map(tool => tool.name), TOOL_NAMES);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const httpResult = await direct.callTool({ name: 'bridge_health', arguments: {} });
  const stdioResult = await stdio.callTool({ name: 'bridge_health', arguments: {} });
  assert.ok(!httpResult.isError && !stdioResult.isError);
  const health = stdioResult.structuredContent;
  assert.equal(health.runtime_id, httpResult.structuredContent.runtime_id);
  assert.equal(health.host_pid, httpResult.structuredContent.host_pid);
  assert.equal(health.profile, 'desktop');
  console.log(JSON.stringify({
    verification: 'local-sdk-http-and-stdio',
    target_chatgpt_tool_call: false,
    same_native_host: true,
    tools: tools.map(({ name, annotations }) => ({ name, annotations })),
    health,
  }, null, 2));
} finally {
  await stdio.close();
  await direct.close();
}
