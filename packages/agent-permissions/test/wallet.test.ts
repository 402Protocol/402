import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type EIP1193Provider, type PublicClient, toHex } from 'viem';
import { connectOwnerWallet, discoverInjectedWallets } from '../src/wallet.js';
import { INK_USDC } from '../src/index.js';
const owner = '0x2222222222222222222222222222222222222222';
const manager = '0x1111111111111111111111111111111111111111';
const rpc = { getChainId: async () => 57073, getCode: async () => '0x01',
  readContract: async ({ functionName }: { functionName: string }) => functionName === 'token' ? INK_USDC : '1.0.0',
} as unknown as PublicClient;
function provider(initialChain = 57073) {
  let chain = initialChain; let accounts = [owner]; let rejectSwitch = false;
  const calls: string[] = [];
  const value = { request: async ({ method, params }: { method: string; params?: { chainId: string }[] }) => {
    calls.push(method);
    if (method === 'eth_chainId') return toHex(chain);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return accounts;
    if (method === 'wallet_switchEthereumChain') { if (rejectSwitch) throw new Error('User rejected'); chain = Number(BigInt(params![0].chainId)); return null; }
    throw new Error(`Unexpected signing/broadcast request: ${method}`);
  } } as EIP1193Provider;
  return { value, calls, switchAccount: () => { accounts = ['0x3333333333333333333333333333333333333333']; },
    wrongChain: () => { chain = 1; }, reject: () => { rejectSwitch = true; } };
}
test('Rabby/injected or WalletConnect EIP-1193 provider connects without signatures', async () => {
  const p = provider(); const connected = await connectOwnerWallet(p.value, rpc, manager);
  assert.equal(connected.owner, owner);
  assert.equal(p.calls.includes('wallet_switchEthereumChain'), false);
  assert.equal(p.calls.some((c) => /sign|send/i.test(c)), false);
});
test('requests Ink when needed and propagates rejected network switch', async () => {
  const p = provider(1); await connectOwnerWallet(p.value, rpc, manager);
  assert.equal(p.calls.includes('wallet_switchEthereumChain'), true);
  const reject = provider(1); reject.reject();
  await assert.rejects(connectOwnerWallet(reject.value, rpc, manager), /User rejected/);
});
test('stops before signing if user changes account or network', async () => {
  for (const change of ['account', 'chain']) {
    const p = provider(); const connected = await connectOwnerWallet(p.value, rpc, manager);
    if (change === 'account') p.switchAccount(); else p.wrongChain();
    await assert.rejects(connected.revokeTokenApproval(), /account changed|Select Ink/);
    assert.equal(p.calls.some((c) => /sign|send/i.test(c)), false);
  }
});
test('EIP-6963 discovers Rabby without silently selecting it and cleans up listeners', () => {
  const target = new EventTarget(); const wallets: string[] = [];
  const cleanup = discoverInjectedWallets(target as unknown as Window, (w) => wallets.push(w.info.rdns));
  const detail = { info: { uuid: 'rabby-1', rdns: 'io.rabby', name: 'Rabby', icon: '' }, provider: provider().value };
  target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  assert.deepEqual(wallets, ['io.rabby']); cleanup();
  target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { ...detail, info: { ...detail.info, uuid: 'rabby-2' } } }));
  assert.equal(wallets.length, 1);
});

test('a successful cancellation/replacement receipt is never reported as a completed revocation', async () => {
  const hash = `0x${'01'.repeat(32)}`;
  const p = provider();
  const originalRequest = p.value.request.bind(p.value);
  const walletProvider = { request: async (args: { method: string }) => args.method === 'eth_sendTransaction' ? hash : originalRequest(args as never) } as EIP1193Provider;
  const client = { ...rpc, call: async () => ({ data: '0x' }), waitForTransactionReceipt: async () => ({
    status: 'success', transactionHash: `0x${'02'.repeat(32)}`,
  }) } as unknown as PublicClient;
  const connected = await connectOwnerWallet(walletProvider, client, manager);
  await assert.rejects(connected.revokeTokenApproval(), /Transaction was replaced/);
});
