/**
 * Offline shape test for the LIVE claim provisioner (delegated-root pattern).
 *
 * No network, no real Turnkey org: a stub fetchImpl records every request and
 * returns canned V4 results. Verifies what tonight's live proofs determined:
 *   1. provisionWallet creates the sub-org with an ephemeral server root key
 *      (valid rootUsers shape) and reads createSubOrganizationResultV4.
 *   2. registerPasskey creates the owner INSIDE the sub-org, stamped by the
 *      sub-org's own root key (organizationId = sub-org, not the parent).
 *   3. provisionAgentKey stamps the agent user + all 7 Design-B policies with
 *      the sub-org root key — no parent-credential override anywhere.
 *   4. All submit paths are snake_case (/public/v1/submit/create_users, ...).
 *
 * Run: npx tsx --test test/claim-live-shapes.test.ts
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { TurnkeySigner } from '../src/taap/signer.js';
import { createProvisioner } from '../src/claim/turnkey.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

type EcKeyPair = { publicKey: any; privateKey: any };
function compressedPub(kp: EcKeyPair): string {
  const jwk = kp.publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  return ((y[y.length - 1] & 1) === 0 ? '02' : '03') + x.toString('hex');
}
function privHex(kp: EcKeyPair): string {
  const jwk = kp.privateKey.export({ format: 'jwk' }) as { d?: string };
  return Buffer.from(jwk.d!, 'base64url').toString('hex');
}

const PARENT_ORG = 'parent-org-uuid';
const SUB_ORG = 'sub-org-uuid';
const WALLET_ADDR = '0xD2660CCFab5522C0baf950930a473d12a76706d2';

const seen: { url: string; body: any }[] = [];
const stubFetch = async (url: string, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? '{}');
  seen.push({ url, body });
  const type: string = body.type;
  let result: any = {};
  if (type === 'ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4') {
    result = {
      createSubOrganizationResultV4: {
        subOrganizationId: SUB_ORG,
        wallet: { walletId: 'wallet-1', addresses: [WALLET_ADDR] },
      },
    };
  } else if (type === 'ACTIVITY_TYPE_CREATE_USERS_V4') {
    result = { createUsersResult: { userIds: [`user-for-${body.organizationId}`] } };
  } else if (type === 'ACTIVITY_TYPE_CREATE_POLICY_V3') {
    result = { createPolicyResult: { policyId: `policy-${seen.length}` } };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ activity: { result } }),
    text: async () => '',
  };
};

const parentKp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const parentSigner = new TurnkeySigner(
  { orgId: PARENT_ORG, apiPublicKey: compressedPub(parentKp), apiPrivateKeyHex: privHex(parentKp) },
  { fetchImpl: stubFetch as any },
);

const provisioner = createProvisioner({ mode: 'live', signer: parentSigner, fetchImpl: stubFetch as any });

const AGENT_PUB = '03' + 'ab'.repeat(32); // 66-char compressed P-256 hex

await check('provisionWallet: sub-org created with server root key, V4 wallet read inline', async () => {
  const w = await provisioner.provisionWallet('test-label');
  assert.equal(w.subOrgId, SUB_ORG);
  assert.equal(w.walletId, 'wallet-1');
  assert.equal(w.address, WALLET_ADDR);

  const req = seen[0];
  assert.ok(req.url.endsWith('/public/v1/submit/create_sub_organization'), `path: ${req.url}`);
  assert.equal(req.body.organizationId, PARENT_ORG, 'creation is stamped by the parent credential');
  assert.equal(req.body.type, 'ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4');
  const rootUser = req.body.parameters.rootUsers[0];
  assert.equal(rootUser.userName, 'taap-server-root');
  assert.deepEqual(rootUser.authenticators, []);
  assert.deepEqual(rootUser.oauthProviders, []);
  const key = rootUser.apiKeys[0];
  assert.ok(/^[0-9a-fA-F]{66}$/.test(key.publicKey), 'server root key is 66-char compressed P-256');
  assert.equal(key.curveType, 'API_KEY_CURVE_P256');
  assert.ok(key.expirationSeconds, 'server root key has an expiry');
  assert.equal(req.body.parameters.rootQuorumThreshold, 1);
});

await check('registerPasskey: owner created INSIDE the sub-org via its own root key', async () => {
  const w = { subOrgId: SUB_ORG, walletId: 'wallet-1', address: WALLET_ADDR, userId: '' };
  const att = {
    credentialId: 'cred-id-b64u',
    clientDataJson: 'cdj-b64u',
    attestationObject: 'ao-b64u',
    transports: ['internal'],
  };
  const { credentialId } = await provisioner.registerPasskey(w, att, 'challenge-b64u');
  assert.equal(credentialId, 'cred-id-b64u');
  assert.equal(w.userId, `user-for-${SUB_ORG}`);

  const req = seen[1];
  assert.ok(req.url.endsWith('/public/v1/submit/create_users'), `path: ${req.url}`);
  assert.equal(req.body.organizationId, SUB_ORG, 'NOT the parent org — delegated stamping');
  const u = req.body.parameters.users[0];
  assert.equal(u.userName, 'owner');
  assert.deepEqual(u.apiKeys, []);
  assert.equal(u.authenticators[0].authenticatorName, 'claim-passkey');
  assert.equal(u.authenticators[0].challenge, 'challenge-b64u');
  assert.equal(u.authenticators[0].attestation.credentialId, 'cred-id-b64u');
});

await check('provisionAgentKey: agent user + 7 policies stamped by the sub-org root key', async () => {
  const w = { subOrgId: SUB_ORG, walletId: 'wallet-1', address: WALLET_ADDR, userId: `user-for-${SUB_ORG}` };
  const mandate = { chains: [57073], routers: [WALLET_ADDR], perTradeCapWei: '0' };
  const { userId, policyIds } = await provisioner.provisionAgentKey(w, AGENT_PUB, mandate as any);
  assert.equal(userId, `user-for-${SUB_ORG}`);
  assert.equal(policyIds.length, 7);

  const userReq = seen[2];
  assert.ok(userReq.url.endsWith('/public/v1/submit/create_users'), `path: ${userReq.url}`);
  assert.equal(userReq.body.organizationId, SUB_ORG, 'agent user created inside the sub-org');
  const au = userReq.body.parameters.users[0];
  assert.equal(au.apiKeys[0].publicKey, AGENT_PUB);

  const policyReqs = seen.slice(3);
  assert.equal(policyReqs.length, 7);
  for (const pr of policyReqs) {
    assert.ok(pr.url.endsWith('/public/v1/submit/create_policy'), `path: ${pr.url}`);
    assert.equal(pr.body.organizationId, SUB_ORG, 'policies created inside the sub-org');
    assert.ok(
      pr.body.parameters.consensus.includes(`user.id == '${userId}'`),
      'policy consensus scoped to the agent user only',
    );
  }
  const names = policyReqs.map((pr) => pr.body.parameters.policyName);
  assert.ok(names.filter((n) => n.includes('deny')).length >= 4, 'deny policies present');
  assert.ok(names.some((n) => n.includes('allow-swaps')), 'swap allow policy present');
});

await check('no request ever targets the sub-org with the parent credential', async () => {
  for (const s of seen.slice(1)) {
    assert.notEqual(s.body.organizationId, PARENT_ORG, `${s.body.type} must not use the parent org`);
  }
});

console.log(`\nclaim-live-shapes: ${passed} checks passed`);
