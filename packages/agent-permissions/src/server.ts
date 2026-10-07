#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { address } from './index.js';
import { registerPermissionsTools } from './mcp.js';
const server = new McpServer({ name: 'four02-agent-permissions', version: '0.1.0' });
registerPermissionsTools(server, {
  manager: process.env.FOUR02_SPENDING_MANAGER_ADDRESS ? address(process.env.FOUR02_SPENDING_MANAGER_ADDRESS) : undefined,
  rpcUrl: process.env.FOUR02_INK_RPC_URL,
});
await server.connect(new StdioServerTransport());
