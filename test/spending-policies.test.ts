import assert from 'node:assert/strict';
import { getFunctionSelector } from 'viem';
import { buildSpendingPolicies } from '../src/claim/spending-policies.js';
const manager = '0x1111111111111111111111111111111111111111';
const policies = buildSpendingPolicies({ managerAddress: manager, agentUserId: 'test-agent' });
const allows = policies.filter((p) => p.effect === 'EFFECT_ALLOW');
assert.equal(allows.length, 1);
for (const value of [manager, 'eth.tx.chain_id == 57073', 'eth.tx.value == 0', getFunctionSelector('pay(bytes32,address,uint256,bytes32)')]) {
  assert.ok(allows[0].condition.includes(value));
}
for (const deny of ['deny-raw-payload', 'deny-token-transfer', 'deny-policy-mgmt', 'deny-identity-mgmt']) {
  assert.ok(policies.some((p) => p.effect === 'EFFECT_DENY' && p.policyName.endsWith(deny)));
}
assert.throws(() => buildSpendingPolicies({ managerAddress: manager, agentUserId: "agent' || true" }));
assert.throws(() => buildSpendingPolicies({ managerAddress: 'bad', agentUserId: 'test-agent' }));
console.log('PASS: dedicated payment signing policy is bound to Ink, manager and pay selector; owner privileges remain denied');
