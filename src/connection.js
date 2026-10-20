/** Read only bridge-owned connection data, never DSH account configuration. */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connectHealth(stateDir = process.env.CD_CONNECT_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh-linux'), 'cd-connect')) {
  const path = join(stateDir, 'connection.json');
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe bridge connection file permissions');
  const data = JSON.parse(await readFile(path, 'utf8'));
  const url = new URL(data.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Invalid local bridge URL');
  if (!/^[a-f0-9]{64}$/.test(data.token)) throw new Error('Invalid bridge credential');
  const client = new Client({ name: 'cd-connect-local-client', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${data.token}` } } }));
    return client;
  } catch (error) { await client.close(); throw error; }
}
