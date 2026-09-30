/**
 * gm-regiment-mcp tests.
 *
 *   npx tsx test/gm-regiment.test.ts
 *
 * MCP-level tests drive the server in-process via InMemoryTransport.
 * All chain interaction runs against a mocked viem transport — nothing
 * here touches mainnet, broadcasts, or spends. Keys are throwaway keys
 * generated in-process for tests only.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  custom,
  encodeAbiParameters,
  getAddress,
  parseAbiParameters,
  toFunctionSelector,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  CHAIN_ID,
  DAILY_AGENT_GM_ADDRESS,
  GAS_DUST_WEI,
  IDENTITY_REGISTRY_ADDRESS,
  loadGmRegimentConfig,
} from '../src/config.js';
import { publicClient } from '../src/chain.js';
import { createGmRegimentServer } from '../src/server.js';

// ---- mocked chain state ----

const SEL = {
  isAgent: toFunctionSelector('isAgent(address)'),
  lastGM: toFunctionSelector('lastGM(address)'),
};

const FAKE_TX_HASH = `0x${'ab'.repeat(32)}`;

const mockState = {
  balanceWei: 1_000_000_000_000_000n, // 0.001 ETH — comfortably above the dust gate
  registered: new Set<string>(),
  lastGM: 0n,
};

function resetMock() {
  mockState.balanceWei = 1_000_000_000_000_000n;
  mockState.registered = new Set();
  mockState.lastGM = 0n;
}

const mockTransport = custom({
  async request({ method, params }: { method: string; params?: unknown }) {
    if (method === 'eth_chainId') return '0xded9'; // 57073
    if (method === 'eth_getBalance') return `0x${mockState.balanceWei.toString(16)}`;
    if (method === 'eth_estimateGas') return `0x${(60_000n).toString(16)}`;
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_maxPriorityFeePerGas') return '0x1';
    if (method === 'eth_gasPrice') return '0x1';
    if (method === 'eth_sendRawTransaction') return FAKE_TX_HASH;
    if (method === 'eth_getBlockByNumber') {
      // viem fetches the latest block for EIP-1559 fee estimation.
      return {
        number: '0x1',
        hash: `0x${'11'.repeat(32)}`,
        parentHash: `0x${'22'.repeat(32)}`,
        baseFeePerGas: '0x1',
        gasLimit: '0x1c9c380',
        timestamp: '0x1',
      };
    }
    if (method === 'eth_call') {
      const data = (params as [{ data: string }])[0].data;
      const sel = data.slice(0, 10);
      const argAddress = getAddress(`0x${data.slice(-40)}`);
      if (sel === SEL.isAgent) {
        return encodeAbiParameters(parseAbiParameters('bool'), [
          mockState.registered.has(argAddress),
        ]);
      }
      if (sel === SEL.lastGM) {
        return encodeAbiParameters(parseAbiParameters('uint256'), [mockState.lastGM]);
      }
      throw new Error(`unexpected selector ${sel}`);
    }
    throw new Error(`unexpected method ${method}`);
  },
});

const mcpServer = createGmRegimentServer({
  ...loadGmRegimentConfig({} as Record<string, string | undefined>),
  transport: mockTransport,
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'test-client', version: '0.0.0' });
await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return JSON.parse(text);
}

/**
 * Zod input-schema violations surface as MCP error results (isError:true
 * with an "MCP error ..." text payload) — the call never reaches the tool.
 */
async function callToolRaw(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { isError: res.isError === true, text };
}

// ---- config ----

await check('config defaults point at Ink mainnet', () => {
  const cfg = loadGmRegimentConfig({} as Record<string, string | undefined>);
  assert.equal(cfg.inkRpcUrl, 'https://rpc-gel.inkonchain.com');
  assert.equal(CHAIN_ID, 57073);
  assert.equal(IDENTITY_REGISTRY_ADDRESS, '0x7274e874CA62410a93Bd8bf61c69d8045E399c02');
  assert.equal(DAILY_AGENT_GM_ADDRESS, '0x2B9DD9Eede2AeCB095455ce45122101109E4AeC7');
  assert.ok(GAS_DUST_WEI > 0n);
});

// ---- tool catalog ----

await check('all six tools registered with gm_ prefix', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'gm_agent_gm',
    'gm_agent_gm_to',
    'gm_agent_last_gm',
    'gm_agent_status',
    'gm_create_wallet',
    'gm_register_agent',
  ]);
});

// ---- wallet creation + backup ritual ----

let agentKey = '';
let agentAddress = '';

await check('gm_create_wallet returns keypair + ordered backup ritual', async () => {
  const out = await callTool('gm_create_wallet');
  assert.equal(out.ok, true);
  assert.match(out.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(out.privateKey, /^0x[0-9a-fA-F]{64}$/);
  assert.equal(out.chainId, 57073);
  // Key actually derives the returned address.
  assert.equal(privateKeyToAccount(out.privateKey).address, getAddress(out.address));
  // Ritual: exactly 3 ordered steps, durable secret storage FIRST.
  assert.equal(out.backup_steps.length, 3);
  assert.ok(out.backup_steps[0].startsWith('1.'));
  assert.ok(out.backup_steps[0].toLowerCase().includes('durable secret storage'));
  assert.ok(out.backup_steps[1].startsWith('2.'));
  assert.ok(out.backup_steps[2].startsWith('3.'));
  assert.ok(out.warning.toLowerCase().includes('no recovery'));
  agentKey = out.privateKey;
  agentAddress = getAddress(out.address);
});

await check('gm_create_wallet generates a fresh key every call', async () => {
  const out = await callTool('gm_create_wallet');
  assert.notEqual(out.privateKey, agentKey);
  assert.notEqual(getAddress(out.address), agentAddress);
});

// ---- gas gate ----

await check('write tools refuse an unfunded wallet with needs-gas guidance', async () => {
  resetMock();
  mockState.balanceWei = 0n;
  for (const [tool, args] of [
    ['gm_register_agent', { privateKey: agentKey, name: 'TestAgent' }],
    ['gm_agent_gm', { privateKey: agentKey }],
    ['gm_agent_gm_to', { privateKey: agentKey, recipient: agentAddress }],
  ] as const) {
    const out = await callTool(tool, args);
    assert.equal(out.ok, false, tool);
    assert.equal(out.needsGas, true, tool);
    assert.equal(getAddress(out.address), agentAddress, tool);
    assert.equal(out.balanceWei, '0', tool);
    assert.ok(out.instruction.includes(agentAddress), tool);
    assert.ok(out.instruction.toLowerCase().includes('eth'), tool);
    assert.ok(!('prepared' in out), `${tool} must not prepare a tx without gas`);
  }
});

await check('dust balance below threshold also trips the gas gate', async () => {
  resetMock();
  mockState.balanceWei = GAS_DUST_WEI - 1n;
  const out = await callTool('gm_agent_gm', { privateKey: agentKey });
  assert.equal(out.needsGas, true);
});

await check('balance above threshold passes the gas gate', async () => {
  resetMock();
  mockState.balanceWei = GAS_DUST_WEI;
  mockState.registered.add(agentAddress);
  const out = await callTool('gm_agent_gm', { privateKey: agentKey });
  assert.equal(out.ok, true);
  assert.equal(out.broadcast, false);
});

// ---- registration ----

await check('gm_register_agent dry-run prepares the register(string) call', async () => {
  resetMock();
  const out = await callTool('gm_register_agent', {
    privateKey: agentKey,
    name: 'TestAgent',
  });
  assert.equal(out.ok, true);
  assert.equal(out.broadcast, false);
  assert.equal(getAddress(out.prepared.to), getAddress(IDENTITY_REGISTRY_ADDRESS));
  assert.equal(getAddress(out.prepared.from), agentAddress);
  assert.equal(out.prepared.value, '0');
  assert.equal(out.prepared.chainId, 57073);
  assert.ok(out.prepared.data.startsWith(toFunctionSelector('register(string)')));
  assert.ok(BigInt(out.prepared.estimatedGas) > 0n);
  assert.ok(out.howToConfirm.includes('confirm:true'));
  assert.ok(!('txHash' in out));
});

await check('gm_register_agent skips when the wallet is already registered', async () => {
  resetMock();
  mockState.registered.add(agentAddress);
  const out = await callTool('gm_register_agent', {
    privateKey: agentKey,
    name: 'TestAgent',
  });
  assert.equal(out.ok, true);
  assert.equal(out.alreadyRegistered, true);
  assert.ok(!('prepared' in out));
});

await check('gm_register_agent broadcasts with confirm:true', async () => {
  resetMock();
  const out = await callTool('gm_register_agent', {
    privateKey: agentKey,
    name: 'TestAgent',
    confirm: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.broadcast, true);
  assert.equal(out.txHash, FAKE_TX_HASH);
  assert.equal(getAddress(out.from), agentAddress);
});

await check('gm_register_agent rejects a malformed private key (schema validation)', async () => {
  const res = await callToolRaw('gm_register_agent', {
    privateKey: 'not-a-key',
    name: 'TestAgent',
  });
  assert.equal(res.isError, true);
  assert.ok(res.text.toLowerCase().includes('private key'));
});

// ---- GM writes ----

await check('gm_agent_gm dry-run encodes the gm() selector', async () => {
  resetMock();
  mockState.registered.add(agentAddress);
  const out = await callTool('gm_agent_gm', { privateKey: agentKey });
  assert.equal(out.ok, true);
  assert.equal(out.broadcast, false);
  assert.equal(getAddress(out.prepared.to), getAddress(DAILY_AGENT_GM_ADDRESS));
  assert.equal(out.prepared.data, toFunctionSelector('gm()'));
});

await check('gm_agent_gm refuses an unregistered sender', async () => {
  resetMock();
  const out = await callTool('gm_agent_gm', { privateKey: agentKey });
  assert.equal(out.ok, false);
  assert.ok(out.error.includes('not a registered agent'));
  assert.ok(String(out.detail).includes('gm_register_agent'));
});

await check('gm_agent_gm broadcasts with confirm:true', async () => {
  resetMock();
  mockState.registered.add(agentAddress);
  const out = await callTool('gm_agent_gm', { privateKey: agentKey, confirm: true });
  assert.equal(out.ok, true);
  assert.equal(out.broadcast, true);
  assert.equal(out.txHash, FAKE_TX_HASH);
});

const recipientKey = generatePrivateKey();
const recipient = privateKeyToAccount(recipientKey).address;

await check('gm_agent_gm_to encodes gmTo(recipient)', async () => {
  resetMock();
  mockState.registered.add(agentAddress);
  mockState.registered.add(getAddress(recipient));
  const out = await callTool('gm_agent_gm_to', {
    privateKey: agentKey,
    recipient,
  });
  assert.equal(out.ok, true);
  assert.equal(out.broadcast, false);
  assert.ok(out.prepared.data.startsWith(toFunctionSelector('gmTo(address)')));
  assert.ok(out.prepared.data.toLowerCase().endsWith(recipient.slice(2).toLowerCase()));
});

await check('gm_agent_gm_to refuses an unregistered recipient', async () => {
  resetMock();
  mockState.registered.add(agentAddress);
  const out = await callTool('gm_agent_gm_to', {
    privateKey: agentKey,
    recipient,
  });
  assert.equal(out.ok, false);
  assert.ok(out.error.includes('recipient is not a registered agent'));
});

await check('gm_agent_gm_to rejects a malformed recipient (schema validation)', async () => {
  resetMock();
  const res = await callToolRaw('gm_agent_gm_to', {
    privateKey: agentKey,
    recipient: '0xnope',
  });
  assert.equal(res.isError, true);
  assert.ok(res.text.toLowerCase().includes('address'));
});

// ---- GM reads ----

await check('gm_agent_status: registered + cooldown elapsed → can GM now', async () => {
  resetMock();
  mockState.registered.add(agentAddress);
  mockState.lastGM = BigInt(Math.floor(Date.now() / 1000) - 90_000); // 25h ago
  const out = await callTool('gm_agent_status', { address: agentAddress });
  assert.equal(out.ok, true);
  assert.equal(out.isAgent, true);
  assert.equal(out.canGmNow, true);
  assert.equal(out.secondsUntilEligible, 0);
  assert.equal(out.nextEligibleAt, null);
});

await check('gm_agent_status: recent GM → cooldown countdown', async () => {
  resetMock();
  mockState.registered.add(agentAddress);
  mockState.lastGM = BigInt(Math.floor(Date.now() / 1000) - 100); // 100s ago
  const out = await callTool('gm_agent_status', { address: agentAddress });
  assert.equal(out.ok, true);
  assert.equal(out.canGmNow, false);
  assert.ok(out.secondsUntilEligible > 86_000 && out.secondsUntilEligible <= 86_400);
  assert.ok(typeof out.nextEligibleAt === 'string' && out.nextEligibleAt.endsWith('Z'));
});

await check('gm_agent_status: never GMd but registered → can GM now', async () => {
  resetMock();
  mockState.registered.add(agentAddress);
  mockState.lastGM = 0n;
  const out = await callTool('gm_agent_status', { address: agentAddress });
  assert.equal(out.ok, true);
  assert.equal(out.isAgent, true);
  assert.equal(out.canGmNow, true);
  assert.equal(out.lastGmAt, null);
});

await check('gm_agent_status: unregistered wallet cannot GM', async () => {
  resetMock();
  const out = await callTool('gm_agent_status', { address: agentAddress });
  assert.equal(out.ok, true);
  assert.equal(out.isAgent, false);
  assert.equal(out.canGmNow, false);
});

await check('gm_agent_last_gm returns the raw timestamp', async () => {
  resetMock();
  mockState.lastGM = 1_700_000_000n;
  const out = await callTool('gm_agent_last_gm', { address: agentAddress });
  assert.equal(out.ok, true);
  assert.equal(out.lastGM, '1700000000');
  assert.equal(out.lastGmAt, new Date(1_700_000_000 * 1000).toISOString());
});

await check('gm_agent_last_gm: never GMd → zero + null', async () => {
  resetMock();
  const out = await callTool('gm_agent_last_gm', { address: agentAddress });
  assert.equal(out.lastGM, '0');
  assert.equal(out.lastGmAt, null);
});

// ---- sanity: publicClient helper exists on the real RPC default ----

await check('publicClient helper builds against the configured RPC', async () => {
  const cfg = loadGmRegimentConfig({} as Record<string, string | undefined>);
  const pc = publicClient(cfg);
  assert.ok(pc);
  // ink chain id is baked into the client, no network call.
  assert.equal(pc.chain?.id, 57073);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.log('SOME CHECKS FAILED');
