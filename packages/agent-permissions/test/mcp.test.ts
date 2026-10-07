import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPermissionsTools } from '../src/mcp.js';
import { INK_USDC } from '../src/index.js';
import { type PublicClient, zeroAddress } from 'viem';

test('MCP exposes all four tools and fails closed without an explicit deployment', async () => {
  const server = new McpServer({ name: 'test', version: '1' }); registerPermissionsTools(server, {});
  const client = new Client({ name: 'test-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['permissions_grant', 'permissions_pay', 'permissions_revoke', 'permissions_status']);
    const response = await client.callTool({ name: 'permissions_status', arguments: { permissionId: `0x${'01'.repeat(32)}` } });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response), /verified Ink deployment/);
  } finally { await client.close(); await server.close(); }
});

test('configured MCP tools return owner plans, simulated agent plans and same-block status without writes', async () => {
  const owner = '0x2222222222222222222222222222222222222222';
  const agent = '0x3333333333333333333333333333333333333333';
  const service = '0x4444444444444444444444444444444444444444';
  const manager = '0x1111111111111111111111111111111111111111';
  const id = `0x${'01'.repeat(32)}`;
  let simulations = 0;
  const publicClient = {
    getChainId: async () => 57073, getCode: async () => '0x01', getBlock: async () => ({ number: 1n, timestamp: 864000n }),
    readContract: async ({ functionName, args }: { functionName: string; args?: string[] }) => ({
      token: INK_USDC, VERSION: '1.0.0',
      getPermission: { owner: args?.[0] === id ? owner : zeroAddress, agent, dailyLimit: 20_000_000n,
        validAfter: 864000, validUntil: 950400, revoked: false },
      remainingToday: 20_000_000n, allowance: 20_000_000n, balanceOf: 50_000_000n,
    })[functionName],
    simulateContract: async () => { simulations++; return {}; },
  } as unknown as PublicClient;
  const server = new McpServer({ name: 'configured-test', version: '1' }); registerPermissionsTools(server, { manager, publicClient });
  const client = new Client({ name: 'test-client', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, JSON.stringify(res));
    return JSON.parse((res.content as { text: string }[])[0].text);
  };
  try {
    const state = await call('permissions_status', { permissionId: id }); assert.equal(state.available, '20000000');
    const grant = await call('permissions_grant', { owner, agent, dailyLimitUsdc: '20', validAfter: 864000,
      validUntil: 950400, recipients: [service], salt: `0x${'03'.repeat(32)}` });
    assert.equal(grant.status, 'unsigned'); assert.equal(grant.plan.owner, owner);
    const pay = await call('permissions_pay', { permissionId: id, recipient: service, amountUsdc: '1', paymentId: `0x${'02'.repeat(32)}` });
    assert.equal(pay.status, 'unsigned'); assert.equal(pay.agent, agent); assert.equal(simulations, 1);
    const revoke = await call('permissions_revoke', { permissionId: id, owner }); assert.equal(revoke.status, 'unsigned');
  } finally { await client.close(); await server.close(); }
});
