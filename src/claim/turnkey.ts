/**
 * Claim-site Turnkey provisioning.
 *
 * Demo mode: every object is simulated (random ids/addresses/words). The
 * WebAuthn ceremony in the browser is still REAL — that part needs no
 * Turnkey at all.
 *
 * Live mode: delegated-root pattern (live-verified 2026-09-29). The parent
 * credential creates each trader sub-org exactly once and never writes inside
 * it again — Turnkey derives the voter from the stamping key, so a parent key
 * stamping a sub-org activity fails with ORGANIZATION_MISMATCH (proven live).
 * Each sub-org is created with an ephemeral server root API key (24h expiry,
 * private half in this process's memory only); all sub-org writes — the owner
 * passkey user, the agent user, the Design-B policies — are stamped by that
 * key through a per-claim TurnkeySigner. The human's passkey becomes the
 * 'owner' user; the Design-B policies are consensus-scoped to the agent user,
 * so the owner is never bound by the agent's DENY rules and withdraws freely
 * (Design B: agent can't transfer, human pulls via passkey).
 * LIVE-UNVERIFIED: the mnemonic export path still throws until the browser
 * HPKE export is built and verified (readiness item #4) — showing fake words
 * for a real wallet would be worse than refusing.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnkeySigner } from '../taap/signer.js';
import type { FetchImpl } from '../taap/signer.js';
import { buildDesignBPolicies, type AgentMandate } from './policies.js';

export interface ProvisionedWallet {
  subOrgId: string;
  walletId: string;
  /** Turnkey wallet-account address (EVM address, 0x). */
  address: string;
  /** User id that will own the sub-org (created at claim time). */
  userId: string;
}

export interface PasskeyAttestation {
  credentialId: string; // base64url
  clientDataJson: string; // base64url
  attestationObject: string; // base64url
  transports?: string[];
}

let wordlist: string[] | null = null;
function getWordlist(): string[] {
  if (!wordlist) {
    const dir = dirname(fileURLToPath(import.meta.url));
    wordlist = readFileSync(join(dir, 'web', 'bip39.txt'), 'utf8').split('\n').map((w) => w.trim()).filter(Boolean);
    if (wordlist.length < 2048) throw new Error('bip39.txt is incomplete');
  }
  return wordlist;
}

/** Demo: 12 real random BIP39 words. NOT a real wallet mnemonic. */
export function demoMnemonic(): string[] {
  const wl = getWordlist();
  const words: string[] = [];
  const rand = randomBytes(24);
  for (let i = 0; i < 12; i++) {
    words.push(wl[(rand[2 * i] << 8 | rand[2 * i + 1]) % 2048]);
  }
  return words;
}

export function demoAddress(): string {
  return '0x' + randomBytes(20).toString('hex');
}

export interface ClaimProvisioner {
  provisionWallet(label: string): Promise<ProvisionedWallet>;
  registerPasskey(w: ProvisionedWallet, att: PasskeyAttestation, challenge: string): Promise<{ credentialId: string }>;
  exportMnemonic(w: ProvisionedWallet): Promise<{ words: string[] }>;
  /**
   * Design-B agent key provisioning (live): create the scoped, non-root
   * agent user holding the caller-supplied API public key, then attach the
   * Design-B policy set (swaps + scoped approvals only, zero transfers).
   * The agent key is generated client-side; only its public key is sent here.
   * Stamped by the sub-org's own root key (delegated pattern) — a parent
   * credential cannot write inside a sub-org (ORGANIZATION_MISMATCH).
   */
  provisionAgentKey(
    w: ProvisionedWallet,
    agentPublicKeyHex: string,
    mandate: Omit<AgentMandate, 'agentUserId'>,
  ): Promise<{ userId: string; policyIds: string[] }>;
  /**
   * Best-effort teardown of a trader sub-org: delete the Design-B policies,
   * the agent user, the wallet, then the sub-org itself (by its own root
   * key). Used for abandoned/failed claims and for live proofs. Never touches
   * the parent org. Continues past individual failures and reports them.
   */
  teardownSubOrg(
    w: ProvisionedWallet,
    ids: { agentUserId?: string; policyIds?: string[] },
  ): Promise<{ errors: string[] }>;
}

export function createProvisioner(opts: {
  mode: 'demo' | 'live';
  signer?: TurnkeySigner; // required in live mode
  /** Test hook: network impl for the internally-created sub-org root signers. */
  fetchImpl?: FetchImpl;
}): ClaimProvisioner {
  if (opts.mode === 'demo') {
    return {
      async provisionWallet(label: string) {
        void label;
        return {
          subOrgId: `demo-sub-org-${randomUUID()}`,
          walletId: `demo-wallet-${randomUUID()}`,
          address: demoAddress(),
          userId: `demo-user-${randomUUID()}`,
        };
      },
      async registerPasskey(w, att) {
        void w;
        return { credentialId: att.credentialId };
      },
      async exportMnemonic(w) {
        void w;
        return { words: demoMnemonic() };
      },
      async provisionAgentKey(w, agentPublicKeyHex, m) {
        void w;
        void agentPublicKeyHex;
        void m;
        return {
          userId: `demo-agent-user-${randomUUID()}`,
          policyIds: [`demo-policy-${randomUUID()}`],
        };
      },
      async teardownSubOrg(w, ids) {
        void w;
        void ids;
        return { errors: [] };
      },
    };
  }

  // ---- live (delegated-root pattern — live-verified 2026-09-29) ----
  const signer = opts.signer!;
  // Per-claim sub-org root signers, keyed by subOrgId. The private halves live
  // only in this process's memory and expire on Turnkey's side 24h after
  // creation (see provisionWallet). Single-instance claim server assumed — a
  // multi-instance deployment needs this in shared storage.
  const subOrgSigners = new Map<string, TurnkeySigner>();

  /** Ephemeral P-256 keypair, exported as Turnkey API-key credential shapes. */
  function ephemeralRootKey(): { publicKeyHex: string; privateKeyHex: string } {
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = kp.publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
    const priv = kp.privateKey.export({ format: 'jwk' }) as { d?: string };
    const x = Buffer.from(pub.x!, 'base64url');
    const y = Buffer.from(pub.y!, 'base64url');
    const prefix = (y[y.length - 1] & 1) === 0 ? '02' : '03';
    return {
      publicKeyHex: prefix + x.toString('hex'),
      privateKeyHex: Buffer.from(priv.d!, 'base64url').toString('hex'),
    };
  }

  /** The sub-org's own root signer — every sub-org write goes through this. */
  function subOrgSigner(w: ProvisionedWallet): TurnkeySigner {
    const sub = subOrgSigners.get(w.subOrgId);
    if (!sub) throw new Error('turnkey: unknown or expired claim — no sub-org root signer (provisionWallet first)');
    return sub;
  }

  return {
    async provisionWallet(label: string) {
      // The parent credential is used exactly once: to create the sub-org.
      // The sub-org carries an ephemeral server root API key (24h Turnkey-side
      // expiry bounds the blast radius of a server compromise; the human's
      // passkey, attached at claim time, remains root regardless).
      const root = ephemeralRootKey();
      const out = await signer.submitActivity<{
        activity: {
          result?: {
            createSubOrganizationResultV4?: {
              subOrganizationId?: string;
              wallet?: { walletId?: string; addresses?: string[] };
            };
          };
        };
      }>('ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4', {
        subOrganizationName: `taap-trader-${label}`,
        rootUsers: [
          {
            userName: 'taap-server-root',
            apiKeys: [
              {
                apiKeyName: 'taap-server-key',
                publicKey: root.publicKeyHex,
                curveType: 'API_KEY_CURVE_P256',
                expirationSeconds: '86400',
              },
            ],
            authenticators: [],
            oauthProviders: [],
          },
        ],
        rootQuorumThreshold: 1,
        wallet: {
          walletName: 'trading',
          accounts: [
            {
              curve: 'CURVE_SECP256K1',
              pathFormat: 'PATH_FORMAT_BIP32',
              path: "m/44'/60'/0'/0/0",
              addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
            },
          ],
        },
      });
      // Live-confirmed 2026-09-29: the V4 result carries the wallet inline —
      // no follow-up wallet query needed (GET_WALLETS is a query endpoint,
      // not a submit activity).
      const v4 = out.activity?.result?.createSubOrganizationResultV4;
      const subOrgId = v4?.subOrganizationId;
      const walletId = v4?.wallet?.walletId;
      const address = v4?.wallet?.addresses?.[0];
      if (!subOrgId || !walletId || !address) {
        throw new Error('turnkey: sub-org result missing subOrganizationId/wallet');
      }
      subOrgSigners.set(
        subOrgId,
        new TurnkeySigner(
          {
            orgId: subOrgId,
            apiPublicKey: root.publicKeyHex,
            apiPrivateKeyHex: root.privateKeyHex,
          },
          opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
        ),
      );
      return { subOrgId, walletId, address, userId: '' }; // userId set at passkey time
    },
    async registerPasskey(w, att, challenge) {
      // The owner is created INSIDE the sub-org, stamped by its own root key.
      // (The old code created the owner in the parent org — wrong org, and a
      // parent key can't write in the sub-org anyway.) The Design-B policies
      // are consensus-scoped to the agent user, so the owner is never bound by
      // the agent's DENY rules and withdraws freely.
      const sub = subOrgSigner(w);
      const user = await sub.submitActivity<{
        activity: { result?: { createUsersResult?: { userIds?: string[] } } };
      }>('ACTIVITY_TYPE_CREATE_USERS_V4', {
        users: [
          {
            userName: 'owner',
            userTags: [],
            apiKeys: [],
            authenticators: [
              {
                authenticatorName: 'claim-passkey',
                challenge,
                attestation: {
                  credentialId: att.credentialId,
                  clientDataJson: att.clientDataJson,
                  attestationObject: att.attestationObject,
                  transports: att.transports ?? ['internal', 'hybrid'],
                },
              },
            ],
            oauthProviders: [],
          },
        ],
      });
      const userId = user.activity?.result?.createUsersResult?.userIds?.[0];
      if (!userId) throw new Error('turnkey: owner userId missing from response');
      w.userId = userId;
      return { credentialId: att.credentialId };
    },
    async exportMnemonic() {
      // The export must run HPKE in the browser against a real wallet key.
      // The exact activity shape is not verified — refusing is safer than
      // showing words that don't match the wallet.
      throw new Error('LIVE-UNVERIFIED: mnemonic export is not wired for live mode yet. Run CLAIM_MODE=demo.');
    },
    async provisionAgentKey(w, agentPublicKeyHex, m) {
      // Stamped by the sub-org's own root key — no organizationId override.
      // (The old parent-key + override pattern fails live with
      // ORGANIZATION_MISMATCH.)
      const sub = subOrgSigner(w);
      if (!/^[0-9a-fA-F]{66}$/.test(agentPublicKeyHex)) {
        throw new Error('turnkey: agentPublicKeyHex must be 66-char compressed P-256 hex');
      }
      const u = await sub.submitActivity<{
        activity: { result?: { createUsersResult?: { userIds?: string[] } } };
      }>('ACTIVITY_TYPE_CREATE_USERS_V4', {
        users: [{
          userName: 'taap-agent',
          userTags: [],
          apiKeys: [{ apiKeyName: 'taap-agent-key', publicKey: agentPublicKeyHex, curveType: 'API_KEY_CURVE_P256' }],
          authenticators: [],
          oauthProviders: [],
        }],
      });
      const userId = u.activity?.result?.createUsersResult?.userIds?.[0];
      if (!userId) throw new Error('turnkey: agent userId missing from response');
      const defs = buildDesignBPolicies({ ...m, agentUserId: userId });
      const policyIds: string[] = [];
      for (const d of defs) {
        const p = await sub.submitActivity<{
          activity: { result?: { createPolicyResult?: { policyId?: string } } };
        }>('ACTIVITY_TYPE_CREATE_POLICY_V3', {
          policyName: d.policyName,
          effect: d.effect,
          consensus: d.consensus,
          condition: d.condition,
          notes: d.notes,
        });
        const pid = p.activity?.result?.createPolicyResult?.policyId;
        if (!pid) throw new Error(`turnkey: policyId missing for ${d.policyName}`);
        policyIds.push(pid);
      }
      return { userId, policyIds };
    },
    async teardownSubOrg(w, ids) {
      // Stamped by the sub-org's own root key — the parent credential cannot
      // delete a sub-org (it can't even write in one). Best effort: every
      // failure is reported, never thrown.
      const sub = subOrgSigner(w);
      const errors: string[] = [];
      const attempt = async (name: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
          console.log(`      deleted ${name}`);
        } catch (e) {
          const m = (e as Error).message;
          errors.push(`${name}: ${m}`);
          console.log(`      cleanup warning — ${name}: ${m.slice(0, 160)}`);
        }
      };
      for (const pid of ids.policyIds ?? []) {
        await attempt(`policy ${pid.slice(0, 8)}…`, () =>
          sub.submitActivity('ACTIVITY_TYPE_DELETE_POLICY', { policyId: pid }));
      }
      if (ids.agentUserId) {
        await attempt(`agent user ${ids.agentUserId.slice(0, 8)}…`, () =>
          sub.submitActivity('ACTIVITY_TYPE_DELETE_USERS', { userIds: [ids.agentUserId] }));
      }
      await attempt(`wallet ${w.walletId.slice(0, 8)}…`, () =>
        sub.submitActivity('ACTIVITY_TYPE_DELETE_WALLETS', {
          walletIds: [w.walletId],
          deleteWithoutExport: true,
        }));
      await attempt(`sub-org ${w.subOrgId.slice(0, 8)}…`, () =>
        sub.submitActivity('ACTIVITY_TYPE_DELETE_SUB_ORGANIZATION', { deleteWithoutExport: true }));
      subOrgSigners.delete(w.subOrgId);
      return { errors };
    },
  };
}
