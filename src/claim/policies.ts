/**
 * Design-B withdrawal enforcement — Turnkey policy builders.
 *
 * Rule: the agent's Turnkey key signs swaps (and scoped approvals) ONLY.
 * Zero transfers. Only the human — the sub-org root via passkey — can move
 * funds out. Enforcement happens inside Turnkey's enclave at signing time;
 * this module only *authors* the policies. The claim server attaches them
 * to the agent key at provisioning (see turnkey.ts provisionAgentKey).
 *
 * Turnkey policy semantics (verified against tkhq/docs
 * features/policies/language.mdx and tkhq/turnkey-agent-skills
 * skills/managing-policies, 2026-09-28):
 *   1. Root users bypass all policies.
 *   2. DENY wins over any ALLOW.
 *   3. ALLOW match -> the consensus expression decides who may approve.
 *   4. No matching policy -> implicit DENY.
 *   5. The engine does NOT short-circuit: every `eth.tx.*` reference is
 *      guarded by `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'`
 *      (the pattern proven live by scripts/turnkey-ink-proof/proof.ts).
 *
 * Verified `eth.tx` condition fields (language.mdx, EthereumTransaction):
 *   to (string), from (string), data (hex string), value (int wei),
 *   chain_id (int), nonce, gas, max_fee_per_gas, ... String comparisons
 *   support ==, !=, and slicing x[a..b]; ints support <, >, <=, >=, in.
 *
 * DELIBERATE LIMITATION — per-trade ERC-20 amount caps canNOT be expressed
 * in Turnkey's policy language for arbitrary token contracts: amounts live
 * in calldata (a hex *string*), and strings only support == / !=. The
 * decoded-arg fields (function_name, contract_call_args) require a Smart
 * Contract Interface uploaded per token address, which is incompatible with
 * "constrain the verbs, not the nouns" (no token allowlists). So:
 *   - the enclave enforces: selector allowlist (approve), spender allowlist
 *     (approved routers), zero native value, chain allowlist, router allowlist.
 *   - the MCP/signer layer enforces: per-trade ERC-20 amount caps, with
 *     explicit user approval per signature (see src/taap/signer.ts).
 * The native-value cap IS enforceable (eth.tx.value is an int) and is
 * wired to `perTradeCapWei`.
 *
 * The agent key's "signing permission only" is structural, not a key flag:
 * the agent user is non-root, no ALLOW policy names it for anything but
 * the two signing shapes below, and explicit DENYs cover policy, user, and
 * credential management. It cannot loosen its own policy; only the sub-org
 * root (the human's passkey) can change policies.
 */

/** Calldata selectors the policy set reasons about (4-byte, 0x-prefixed). */
export const SELECTOR_APPROVE = '0x095ea7b3'; // approve(address,uint256)
export const SELECTOR_TRANSFER = '0xa9059cbb'; // transfer(address,uint256)
export const SELECTOR_TRANSFER_FROM = '0x23b872dd'; // transferFrom(address,address,uint256)

export interface AgentMandate {
  /** Chain IDs the agent may sign on, e.g. [1, 57073, 4663]. */
  chains: number[];
  /** Approved router contract addresses (any hex case; normalized to lowercase). */
  routers: string[];
  /**
   * Max native value per tx, in wei as a decimal string. Default '0':
   * swaps must carry zero native value. Enforced via eth.tx.value (int).
   * ERC-20 amounts are NOT enforceable here (see module header) — they are
   * capped at the MCP/signer layer.
   */
  perTradeCapWei?: string;
  /** Turnkey user ID of the scoped agent (consensus scoping). */
  agentUserId: string;
  /** Prefix for policy names. Default 'taap-designb'. */
  namePrefix?: string;
}

export interface TurnkeyPolicyDef {
  policyName: string;
  effect: 'EFFECT_ALLOW' | 'EFFECT_DENY';
  consensus: string;
  condition: string;
  notes: string;
}

function assertAddress(a: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`policies: ${what} must be a 0x address, got ${a}`);
  return a.toLowerCase();
}

function assertMandate(m: AgentMandate): { chains: number[]; routers: string[]; capWei: string; prefix: string } {
  if (!m || typeof m !== 'object') throw new Error('policies: mandate is required');
  if (!Array.isArray(m.chains) || m.chains.length === 0) throw new Error('policies: mandate.chains must be non-empty');
  for (const c of m.chains) {
    if (!Number.isInteger(c) || c <= 0) throw new Error(`policies: bad chain id ${c}`);
  }
  if (!Array.isArray(m.routers) || m.routers.length === 0) throw new Error('policies: mandate.routers must be non-empty');
  const routers = m.routers.map((r, i) => assertAddress(r, `mandate.routers[${i}]`));
  if (!m.agentUserId || typeof m.agentUserId !== 'string') throw new Error('policies: mandate.agentUserId is required');
  const capWei = m.perTradeCapWei ?? '0';
  if (!/^\d+$/.test(capWei)) throw new Error('policies: mandate.perTradeCapWei must be a decimal wei string');
  return { chains: [...m.chains], routers, capWei, prefix: m.namePrefix || 'taap-designb' };
}

/**
 * Build the Design-B policy set for one agent user.
 * Pure function — no network. Returns definitions ready for
 * ACTIVITY_TYPE_CREATE_POLICY_V3, in a safe creation order
 * (DENYs first, then ALLOWs).
 */
export function buildDesignBPolicies(mandate: AgentMandate): TurnkeyPolicyDef[] {
  const { chains, routers, capWei, prefix } = assertMandate(mandate);
  const consensus = `approvers.any(user, user.id == '${mandate.agentUserId}')`;
  const chainList = `[${chains.join(', ')}]`;
  const routerList = `[${routers.map((r) => `'${r}'`).join(', ')}]`;
  // Spender check reads the address word of approve(address,uint256) calldata:
  // '0x' + 8 selector chars + 64-char word; the address is the last 40 chars
  // of that word (string indices 34..73). The dual slice covers both
  // possible slice-end semantics (exclusive vs inclusive) in Turnkey's docs.
  const routerBareList = `[${routers.map((r) => `'${r.slice(2)}'`).join(', ')}]`;
  const txV2 = `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'`;

  return [
    {
      policyName: `${prefix}-deny-raw-payload`,
      effect: 'EFFECT_DENY',
      consensus,
      condition:
        `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' || ` +
        `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS' || ` +
        `activity.type == 'ACTIVITY_TYPE_ETH_SEND_TRANSACTION'`,
      notes: 'Design B: the agent key may never sign raw payloads (policy bypass) nor use Turnkey-managed sends.',
    },
    {
      policyName: `${prefix}-deny-native-value`,
      effect: 'EFFECT_DENY',
      consensus,
      condition: `${txV2} && eth.tx.value > ${capWei}`,
      notes: `Design B: the agent key may never move native value above ${capWei} wei per tx.`,
    },
    {
      policyName: `${prefix}-deny-token-transfer`,
      effect: 'EFFECT_DENY',
      consensus,
      condition:
        `${txV2} && (` +
        `eth.tx.data[0..10] == '${SELECTOR_TRANSFER}' || eth.tx.data[0..9] == '${SELECTOR_TRANSFER}' || ` +
        `eth.tx.data[0..10] == '${SELECTOR_TRANSFER_FROM}' || eth.tx.data[0..9] == '${SELECTOR_TRANSFER_FROM}')`,
      notes: 'Design B: the agent key may never sign ERC-20 transfer/transferFrom. Withdrawals are human-only.',
    },
    {
      policyName: `${prefix}-deny-policy-mgmt`,
      effect: 'EFFECT_DENY',
      consensus,
      condition: `activity.resource == 'POLICY'`,
      notes: 'Design B: the agent key may never create, update, or delete policies. Only the sub-org root can.',
    },
    {
      policyName: `${prefix}-deny-identity-mgmt`,
      effect: 'EFFECT_DENY',
      consensus,
      condition: `activity.resource == 'USER' || activity.resource == 'CREDENTIAL'`,
      notes: 'Design B: the agent key may never manage users, API keys, or authenticators.',
    },
    {
      policyName: `${prefix}-allow-swaps`,
      effect: 'EFFECT_ALLOW',
      consensus,
      condition:
        `${txV2} && eth.tx.chain_id in ${chainList} && ` +
        `eth.tx.to in ${routerList} && eth.tx.value <= ${capWei}`,
      notes: 'Design B: the agent may sign swaps to approved routers on mandate chains within the native-value cap.',
    },
    {
      policyName: `${prefix}-allow-approvals`,
      effect: 'EFFECT_ALLOW',
      consensus,
      condition:
        `${txV2} && eth.tx.chain_id in ${chainList} && ` +
        `(eth.tx.data[0..10] == '${SELECTOR_APPROVE}' || eth.tx.data[0..9] == '${SELECTOR_APPROVE}') && ` +
        `(eth.tx.data[34..74] in ${routerBareList} || eth.tx.data[34..73] in ${routerBareList}) && ` +
        `eth.tx.value == 0`,
      notes:
        'Design B: the agent may sign approve(address,uint256) only with spender = an approved router. ' +
        'Per-trade ERC-20 amount caps are enforced at the MCP/signer layer (not expressible in policy language).',
    },
  ];
}
