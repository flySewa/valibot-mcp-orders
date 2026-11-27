import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

// Start the server over stdio: the AI app talks to it through stdin/stdout.
const handle = serveStdio(() => createServer());

// Log to stderr only. stdout carries the MCP messages, so console.log would break them.
console.error('shop-orders MCP server is running on stdio');

process.on('SIGINT', async () => {
  await handle.close();
  process.exit(0);
});
