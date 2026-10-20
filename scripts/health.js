/** Local SDK probe. This does not count as a target ChatGPT tool invocation. */
import { connectHealth } from '../src/connection.js';
try {
  const client = await connectHealth();
  try {
    const result = await client.callTool({ name: 'bridge_health', arguments: {} });
    if (result.isError) throw new Error('Health check failed');
    console.log(JSON.stringify(result.structuredContent, null, 2));
  } finally { await client.close(); }
} catch {
  console.error('Cannot reach the native bridge. Check DSH, plugin status and CD_CONNECT_STATE_DIR.');
  process.exitCode = 1;
}
