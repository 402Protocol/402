/**
 * 402 Phase 2 — EIP-3009 helpers for the `exact` scheme on EVM.
 *
 * The payment payload is a payer-signed TransferWithAuthorization:
 *   TransferWithAuthorization(address from, address to, uint256 value,
 *     uint256 validAfter, uint256 validBefore, bytes32 nonce)
 * The facilitator submits it via USDC.transferWithAuthorization(...), moving
 * funds payer -> recipient directly. The facilitator never custodies funds;
 * the settler key only pays gas.
 */
import { randomBytes } from 'node:crypto';
import {
  type Address,
  type Hex,
  defineChain,
  getAddress,
  parseAbiItem,
  parseSignature,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainConfig } from './chains.js';
import type { ExactEvmPayload } from './types.js';

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function eip3009Domain(cfg: ChainConfig) {
  return {
    name: cfg.usdc.eip712Name,
    version: cfg.usdc.eip712Version,
    chainId: cfg.chainId,
    verifyingContract: cfg.usdc.address,
  } as const;
}

export const usdcEip3009Abi = [
  parseAbiItem(
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  ),
  parseAbiItem(
    'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  ),
  parseAbiItem('function balanceOf(address account) view returns (uint256)'),
] as const;

/** Build a viem Chain object from a ChainConfig (keeps viem out of chains.ts). */
export function viemChain(cfg: ChainConfig) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

/** Fresh random EIP-3009 nonce (bytes32). */
export function randomNonce(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

/** Split an ECDSA signature into v/r/s for transferWithAuthorization. */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const sig = parseSignature(signature);
  const v =
    sig.v !== undefined ? Number(sig.v) : sig.yParity === 0 ? 27 : 28;
  return { v, r: sig.r, s: sig.s };
}

export interface AuthorizationParams {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/**
 * Sign a TransferWithAuthorization with the payer's key. Used by tests and by
 * any payer client; the facilitator itself never calls this with real keys.
 */
export async function signAuthorization(
  cfg: ChainConfig,
  payerKey: Hex,
  params: AuthorizationParams,
): Promise<ExactEvmPayload> {
  const account = privateKeyToAccount(payerKey);
  if (getAddress(account.address) !== getAddress(params.from)) {
    throw new Error('payer key does not match authorization.from');
  }
  const signature = await account.signTypedData({
    domain: eip3009Domain(cfg),
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(params.from),
      to: getAddress(params.to),
      value: params.value,
      validAfter: params.validAfter,
      validBefore: params.validBefore,
      nonce: params.nonce,
    },
  });
  return {
    signature,
    authorization: {
      from: getAddress(params.from),
      to: getAddress(params.to),
      value: params.value.toString(),
      validAfter: params.validAfter.toString(),
      validBefore: params.validBefore.toString(),
      nonce: params.nonce,
    },
  };
}
