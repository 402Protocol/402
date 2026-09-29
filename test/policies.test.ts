/**
 * Design-B policy builder tests (pure functions, no network).
 *
 * Run: npx tsx test/policies.test.ts   (or: npm run test:policies)
 */
import assert from 'node:assert/strict';
import {
  buildDesignBPolicies,
  SELECTOR_APPROVE,
  SELECTOR_TRANSFER,
  SELECTOR_TRANSFER_FROM,
  type AgentMandate,
} from '../src/claim/policies.js';

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

const ROUTER = '0x1111111111111111111111111111111111111111';
const ROUTER2 = '0x2222222222222222222222222222222222222222';
const AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mandate(over: Partial<AgentMandate> = {}): AgentMandate {
  return {
    chains: [1, 57073, 4663],
    routers: [ROUTER],
    agentUserId: AGENT,
    ...over,
  };
}

await check('builds 7 policies, DENYs first then ALLOWs', () => {
  const ps = buildDesignBPolicies(mandate());
  assert.equal(ps.length, 7);
  const effects = ps.map((p) => p.effect);
  assert.deepEqual(effects, [
    'EFFECT_DENY', 'EFFECT_DENY', 'EFFECT_DENY', 'EFFECT_DENY', 'EFFECT_DENY',
    'EFFECT_ALLOW', 'EFFECT_ALLOW',
  ]);
});

await check('every policy carries the agent consensus', () => {
  const ps = buildDesignBPolicies(mandate());
  for (const p of ps) {
    assert.ok(
      p.consensus === `approvers.any(user, user.id == '${AGENT}')`,
      `${p.policyName}: bad consensus`,
    );
  }
});

await check('raw-payload DENY covers V2, batch, and managed sends', () => {
  const p = buildDesignBPolicies(mandate())[0];
  assert.equal(p.effect, 'EFFECT_DENY');
  assert.ok(p.condition.includes(`'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'`));
  assert.ok(p.condition.includes(`'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'`));
  assert.ok(p.condition.includes(`'ACTIVITY_TYPE_ETH_SEND_TRANSACTION'`));
});

await check('native-value DENY defaults to > 0', () => {
  const p = buildDesignBPolicies(mandate())[1];
  assert.ok(p.condition.includes('eth.tx.value > 0'), p.condition);
});

await check('native-value DENY follows perTradeCapWei', () => {
  const p = buildDesignBPolicies(mandate({ perTradeCapWei: '1000000000000000000' }))[1];
  assert.ok(p.condition.includes('eth.tx.value > 1000000000000000000'), p.condition);
});

await check('token-transfer DENY covers transfer and transferFrom selectors', () => {
  const p = buildDesignBPolicies(mandate())[2];
  assert.equal(p.effect, 'EFFECT_DENY');
  assert.ok(p.condition.includes(SELECTOR_TRANSFER), p.condition);
  assert.ok(p.condition.includes(SELECTOR_TRANSFER_FROM), p.condition);
  // both slice-end variants present (docs ambiguity guard)
  assert.ok(p.condition.includes('eth.tx.data[0..10]'), p.condition);
  assert.ok(p.condition.includes('eth.tx.data[0..9]'), p.condition);
});

await check('policy-mgmt DENY targets POLICY resource', () => {
  const p = buildDesignBPolicies(mandate())[3];
  assert.ok(p.condition.includes(`activity.resource == 'POLICY'`), p.condition);
});

await check('identity-mgmt DENY targets USER and CREDENTIAL resources', () => {
  const p = buildDesignBPolicies(mandate())[4];
  assert.ok(p.condition.includes(`activity.resource == 'USER'`), p.condition);
  assert.ok(p.condition.includes(`activity.resource == 'CREDENTIAL'`), p.condition);
});

await check('swap ALLOW: chains, router allowlist, value cap', () => {
  const p = buildDesignBPolicies(mandate({ routers: [ROUTER, ROUTER2] }))[5];
  assert.equal(p.effect, 'EFFECT_ALLOW');
  assert.ok(p.condition.includes(`activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'`), p.condition);
  assert.ok(p.condition.includes('eth.tx.chain_id in [1, 57073, 4663]'), p.condition);
  assert.ok(p.condition.includes(`'${ROUTER}'`), p.condition);
  assert.ok(p.condition.includes(`'${ROUTER2}'`), p.condition);
  assert.ok(p.condition.includes('eth.tx.value <= 0'), p.condition);
});

await check('approval ALLOW: approve selector, spender allowlist, zero value', () => {
  const p = buildDesignBPolicies(mandate())[6];
  assert.equal(p.effect, 'EFFECT_ALLOW');
  assert.ok(p.condition.includes(SELECTOR_APPROVE), p.condition);
  // bare (no-0x) router addresses for the calldata-word comparison
  assert.ok(p.condition.includes(`'${ROUTER.slice(2)}'`), p.condition);
  assert.ok(p.condition.includes('eth.tx.data[34..74]'), p.condition);
  assert.ok(p.condition.includes('eth.tx.data[34..73]'), p.condition);
  assert.ok(p.condition.includes('eth.tx.value == 0'), p.condition);
  // must NOT allow transfer selectors
  assert.ok(!p.condition.includes(SELECTOR_TRANSFER), p.condition);
  assert.ok(!p.condition.includes(SELECTOR_TRANSFER_FROM), p.condition);
});

await check('router addresses are normalized to lowercase', () => {
  const upper = '0xABcDEF1234567890ABcDEF1234567890ABcDEF12';
  const ps = buildDesignBPolicies(mandate({ routers: [upper] }));
  const swap = ps[5];
  const appr = ps[6];
  assert.ok(swap.condition.includes(`'${upper.toLowerCase()}'`), swap.condition);
  assert.ok(!swap.condition.includes(upper), swap.condition);
  assert.ok(appr.condition.includes(`'${upper.toLowerCase().slice(2)}'`), appr.condition);
});

await check('policy names use the prefix', () => {
  const ps = buildDesignBPolicies(mandate({ namePrefix: 'taap-proof-designb' }));
  for (const p of ps) assert.ok(p.policyName.startsWith('taap-proof-designb-'), p.policyName);
  const names = ps.map((p) => p.policyName);
  assert.equal(new Set(names).size, names.length, 'policy names must be unique');
});

await check('approval notes document the MCP-layer amount cap', () => {
  const p = buildDesignBPolicies(mandate())[6];
  assert.ok(p.notes.includes('MCP/signer layer'), p.notes);
});

await check('invalid mandates throw', () => {
  assert.throws(() => buildDesignBPolicies(mandate({ chains: [] })), /chains/);
  assert.throws(() => buildDesignBPolicies(mandate({ routers: [] })), /routers/);
  assert.throws(() => buildDesignBPolicies(mandate({ routers: ['0xnope'] })), /0x address/);
  assert.throws(() => buildDesignBPolicies(mandate({ agentUserId: '' })), /agentUserId/);
  assert.throws(() => buildDesignBPolicies(mandate({ perTradeCapWei: '1.5' })), /wei string/);
  assert.throws(() => buildDesignBPolicies(mandate({ chains: [0] })), /chain id/);
});

console.log(`\n${passed} checks passed`);
