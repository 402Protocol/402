/** Optional policies for a dedicated payment-agent key. Does not modify existing swap-only TAAP keys. */
import { getFunctionSelector } from 'viem';
import { buildDesignBPolicies, type TurnkeyPolicyDef } from './policies.js';

export function buildSpendingPolicies(input: { managerAddress: string; agentUserId: string }): TurnkeyPolicyDef[] {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.agentUserId)) throw new Error('Invalid Turnkey agent user ID');
  const base = buildDesignBPolicies({ agentUserId: input.agentUserId, chains: [57073], routers: [input.managerAddress],
    perTradeCapWei: '0', namePrefix: 'four02-spending' });
  const selector = getFunctionSelector('pay(bytes32,address,uint256,bytes32)');
  return [...base.filter((p) => p.effect === 'EFFECT_DENY'), {
    policyName: 'four02-spending-allow-pay', effect: 'EFFECT_ALLOW',
    consensus: `approvers.any(user, user.id == '${input.agentUserId}')`,
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 57073 && ` +
      `eth.tx.to == '${input.managerAddress.toLowerCase()}' && eth.tx.value == 0 && ` +
      `(eth.tx.data[0..10] == '${selector}' || eth.tx.data[0..9] == '${selector}')`,
    notes: 'Dedicated payment key: only pay() on the pinned Ink manager. Owner grants, recipient rules, cumulative USDC budgets, expiry and revocation are enforced onchain. No owner approvals or policy changes.',
  }];
}
