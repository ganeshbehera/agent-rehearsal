import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RehearsalEngine } from './engine.js';
import { createMcpServer } from './mcp-server.js';
import { dbPath } from './config.js';

const engine = new RehearsalEngine(dbPath);
const server = createMcpServer(engine);
let closed = false;
function closeDatabase() {
  if (!closed) {
    closed = true;
    engine.close();
  }
}
server.server.onclose = closeDatabase;
await server.connect(new StdioServerTransport());
async function shutdown() {
  await server.close();
  closeDatabase();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
