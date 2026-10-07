import { type Address, type EIP1193Provider, type PublicClient, createWalletClient, custom, getAddress, toHex } from 'viem';
import { type Call, type GrantInput, INK_CHAIN_ID, address, approvalCall, createPermissionsClient, ink } from './index.js';

export interface InjectedWallet {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}
/** Browser only. Discovery never requests accounts, signs, switches networks or picks a wallet for the user. */
export function discoverInjectedWallets(target: Window, onWallet: (wallet: InjectedWallet) => void): () => void {
  const seen = new Set<string>();
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<InjectedWallet>).detail;
    if (!detail?.provider?.request || typeof detail.info?.uuid !== 'string' || typeof detail.info?.rdns !== 'string'
      || typeof detail.info?.name !== 'string' || seen.has(detail.info.uuid)) return;
    seen.add(detail.info.uuid); onWallet(detail);
  };
  target.addEventListener('eip6963:announceProvider', announce);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => target.removeEventListener('eip6963:announceProvider', announce);
}

/**
 * Call from a human's Connect button. Accepts a selected Rabby EIP-6963 provider or a
 * connected WalletConnect Ethereum provider (e.g. Kraken Wallet). Never takes private keys.
 * WalletConnect session/QR creation belongs to the host app and requires its own project ID.
 */
export async function connectOwnerWallet(provider: EIP1193Provider, publicClient: PublicClient, manager: Address) {
  const permissions = createPermissionsClient(publicClient, manager);
  await permissions.checkDeployment();
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new Error('Wallet did not provide an account');
  const owner = address(accounts[0]);
  if (BigInt(await provider.request({ method: 'eth_chainId' })) !== BigInt(INK_CHAIN_ID)) {
    // Do not silently fall back to Ethereum or bridge funds if the wallet rejects Ink.
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(INK_CHAIN_ID) }] });
  }
  async function checkSession() {
    const [chainId, currentAccounts] = await Promise.all([
      provider.request({ method: 'eth_chainId' }), provider.request({ method: 'eth_accounts' }),
    ]);
    if (BigInt(chainId) !== BigInt(INK_CHAIN_ID)) throw new Error('Select Ink in your wallet');
    if (!currentAccounts[0] || getAddress(currentAccounts[0]) !== owner) throw new Error('Wallet account changed; reconnect before approving');
  }
  await checkSession();
  const wallet = createWalletClient({ account: owner, chain: ink, transport: custom(provider) });
  async function send(call: Call) {
    await permissions.checkDeployment();
    await checkSession();
    await publicClient.call({ account: owner, ...call });
    await checkSession();
    const hash = await wallet.sendTransaction(call);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
    // Wallet cancellation is itself a successful replacement transaction. It does not approve/revoke.
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`Transaction was replaced; check onchain permission/approval status before retrying: ${hash}`);
    }
    if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
    return receipt;
  }
  return {
    owner,
    /** Display this finite approval and permission plan before asking the human to confirm. */
    async previewGrant(input: Omit<GrantInput, 'owner'>) {
      await checkSession();
      return permissions.prepareGrant({ ...input, owner });
    },
    /** Explicit human action: each transaction requires wallet confirmation. Stops on rejection/failure. */
    async grant(input: Omit<GrantInput, 'owner'>) {
      await checkSession();
      const plan = await permissions.prepareGrant({ ...input, owner });
      const receipts = [];
      for (const call of plan.calls) receipts.push(await send(call));
      return { permissionId: plan.permissionId, receipts };
    },
    async revoke(permissionId: `0x${string}`) {
      await checkSession();
      const plan = await permissions.prepareRevoke(permissionId, owner);
      return send(plan.calls[0]);
    },
    /** Stops spending for ALL grants belonging to this owner by zeroing the shared token allowance. */
    async revokeTokenApproval() { return send(approvalCall(manager, 0n)); },
    status: permissions.status,
  };
}
