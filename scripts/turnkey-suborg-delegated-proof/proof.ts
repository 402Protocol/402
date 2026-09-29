#!/usr/bin/env npx tsx
/**
 * Turnkey SUB-ORG DELEGATED proof — RUN ON YOUR OWN MACHINE.
 * Your Turnkey API private key never leaves this process.
 *
 * The first sub-org proof (scripts/turnkey-suborg-proof/proof.ts) proved the
 * NEGATIVE: a parent-org credential CANNOT write inside a sub-org —
 * CREATE_USERS with the parent key + organizationId override fails with
 * ORGANIZATION_MISMATCH ("voters are in organization (parent)"). Turnkey
 * identifies the voter from the stamping key, full stop.
 *
 * This script proves the POSITIVE — the delegated-root pattern Turnkey's own
 * docs prescribe (migration guide, with-passkeys example), which is what the
 * claim server must be redesigned around:
 *   1. parent credential -> CREATE_SUB_ORGANIZATION_V4 with an embedded EVM
 *      wallet AND an ephemeral P-256 root API key registered at creation
 *      (in the real claim flow this slot holds the HUMAN'S PASSKEY as root
 *      authenticator + a short-lived claim-server API key; here one throwaway
 *      key plays both roles)
 *   2. SUB-ORG ROOT KEY -> scoped agent user IN the sub-org
 *   3. SUB-ORG ROOT KEY -> the 7 Design-B policies IN the sub-org
 *   4. checks: (a) agent signs a router-shaped swap via the sub-org wallet -> SIGNED
 *               (b) agent signs a plain native transfer                    -> POLICY DENY
 *   5. best-effort cleanup: policies, user, wallet — then the sub-org ITSELF,
 *      deleted BY its own root key (the delete should SUCCEED this time,
 *      because the deleter is a sub-org root user)
 *
 * Nothing is broadcast. No funds move (signing needs no balance). Only
 * api.turnkey.com is touched. No secrets are printed — only truncated IDs.
 *
 * Env (same as the other proofs):
 *   TURNKEY_ORG_ID
 *   TURNKEY_API_PUBLIC_KEY    parent-org API key public key, exactly as the dashboard shows it
 *   TURNKEY_API_PRIVATE_KEY   parent-org API key private key (hex, shown once at creation)
 *
 * Run:  npx tsx proof.ts
 * Self-test (no network): npx tsx proof.ts --self-test
 */

import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { createInterface } from "node:readline";
import { buildDesignBPolicies } from "../../src/claim/policies.js";

const API = "https://api.turnkey.com";
const CHAIN_ID = 57073n; // Ink mainnet, one of the mandate chains

// Dummy "approved router" and EOA for the proof mandate.
const ROUTER = "0x1111111111111111111111111111111111111111";
const EOA = "0x3333333333333333333333333333333333333333";

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function loadEnv() {
  let org = process.env.TURNKEY_ORG_ID?.trim() || "";
  let pub = process.env.TURNKEY_API_PUBLIC_KEY?.replace(/^0x/, "").trim();
  let privHex = process.env.TURNKEY_API_PRIVATE_KEY?.replace(/^0x/, "").trim();
  if (!org) org = (await prompt("Turnkey org ID: ")).trim();
  if (!pub) pub = (await prompt("API public key (paste exactly as the dashboard shows it): ")).replace(/^0x/, "");
  if (!privHex) privHex = (await prompt("API private key (the one shown once at creation): ")).replace(/^0x/, "");
  if (!org || !pub || !/^[0-9a-fA-F]{64}$/.test(privHex)) {
    fail("Need all three: TURNKEY_ORG_ID, API public key, and the 64-char hex API private key.");
  }
  return { org, pub, privHex };
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const trunc = (s: string) => (s.length > 14 ? s.slice(0, 8) + "…" + s.slice(-4) : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- bytes / RLP (same as turnkey-withdrawal-proof) ----------------
const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hexToBytes = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

function intToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return hexToBytes(h);
}

function concat(...arrs: Uint8Array[]): Buffer {
  return Buffer.concat(arrs.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
}
function rlpLenPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([offset + len]);
  const b = intToBytes(BigInt(len));
  return concat(new Uint8Array([offset + 55 + b.length]), b);
}
type RlpIn = Uint8Array | RlpIn[];
function rlpEncode(input: RlpIn): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0] < 0x80) return input;
    return concat(rlpLenPrefix(input.length, 0x80), input);
  }
  const body = concat(...(input as RlpIn[]).map(rlpEncode));
  return concat(rlpLenPrefix(body.length, 0xc0), body);
}

// ---------------- Turnkey stamping (P-256 over the request body) ----------------
function importPrivKey(hex: string) {
  const d = hexToBytes(hex);
  if (d.length !== 32) fail("Private key must be 32 bytes.");
  const der = concat(
    hexToBytes("30310201010420"), d,
    hexToBytes("a00a06082a8648ce3d030107"),
  );
  return createPrivateKey({ key: Buffer.from(der), format: "der", type: "sec1" });
}

function stamp(body: string, pubHex: string, priv: ReturnType<typeof createPrivateKey>): string {
  const signer = createSign("SHA256");
  signer.write(Buffer.from(body, "utf8"));
  signer.end();
  const derHex: string = signer.sign(priv, "hex");
  const stampJson = JSON.stringify({
    publicKey: pubHex,
    scheme: "SIGNATURE_SCHEME_TK_API_P256",
    signature: derHex,
  });
  return Buffer.from(stampJson, "utf8").toString("base64url");
}

function compressedPubHex(xB64u: string, yB64u: string): string {
  const x = Buffer.from(xB64u, "base64url");
  const y = Buffer.from(yB64u, "base64url");
  const prefix = (y[y.length - 1] & 1) === 0 ? "02" : "03";
  return prefix + x.toString("hex");
}

interface Creds { pub: string; priv: any }
/** Transport: mirrors TurnkeySigner.submitActivity's organizationId override. */
type TkCall = (path: string, activityType: string, params: any, creds: Creds, orgId: string) => Promise<any>;

function makeLiveCall(): TkCall {
  return async (path, activityType, parameters, creds, orgId) => {
    const body = JSON.stringify({
      type: activityType,
      organizationId: orgId,
      timestampMs: Date.now().toString(),
      parameters,
    });
    let res: Response;
    try {
      res = await fetch(API + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Stamp": stamp(body, creds.pub, creds.priv) },
        body,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e: any) {
      throw new Error(`${path} -> network error: ${e.message}`);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(json).slice(0, 600)}`);
    const activity = json.activity;
    if (!activity) throw new Error(`${path} -> no activity in response: ${JSON.stringify(json).slice(0, 300)}`);
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(
        `${path} -> ${activity.status}: ${JSON.stringify(activity.result ?? activity).slice(0, 800)}`
      );
    }
    return activity.result;
  };
}

// ---------------- tx builder ----------------
function unsignedTx(to: string, value: bigint, dataHex: string): string {
  const fields: RlpIn[] = [
    intToBytes(CHAIN_ID),
    intToBytes(0n),
    intToBytes(100_000_000n),
    intToBytes(1_000_000_000n),
    intToBytes(21000n),
    hexToBytes(to),
    intToBytes(value),
    hexToBytes(dataHex),
    [],
  ];
  return "0x02" + bytesToHex(rlpEncode(fields));
}

// ---------------- the proof flow (transport-injected so --self-test can mock it) ----------------
interface FlowResult {
  failures: number;
  subOrgId: string;
  walletId: string;
  address: string;
  agentUserId: string;
  policyIds: string[];
  resultField: string; // which createSubOrganization result field carried the data
  subOrgDeleted: boolean;
  subOrgDeleteError: string | null;
}

async function runFlow(call: TkCall, parentCreds: Creds, parentOrgId: string, opts: { skipDelays?: boolean } = {}): Promise<FlowResult> {
  let failures = 0;
  const verdict = (name: string, ok: boolean, detail?: string) => {
    console.log(`      ${ok ? "PASS" : "FAIL"} — ${name}${detail ? `\n      ${detail}` : ""}`);
    if (!ok) failures++;
  };
  const created = { policies: [] as string[], users: [] as string[], wallets: [] as string[] };

  console.log("== Turnkey sub-org targeting proof ==\n");

  console.log("[1/6] Parent credential -> CREATE_SUB_ORGANIZATION_V4…");
  // LIVE FINDING 2026-09-29: rootUsers: [] is rejected with HTTP 400 — a
  // sub-org must have at least one root user. Register an ephemeral throwaway
  // root key (mirrors the real design, where the human's passkey becomes the
  // trader sub-org's root at claim time). turnkey.ts must be fixed the same way.
  const rootKp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rootJwk = rootKp.publicKey.export({ format: "jwk" }) as any;
  const rootPubHex = compressedPubHex(rootJwk.x, rootJwk.y);
  const so = await call("/public/v1/submit/create_sub_organization", "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4", {
    subOrganizationName: "taap-suborg-proof-" + Date.now().toString(36),
    rootUsers: [{
      userName: "taap-suborg-proof-root",
      apiKeys: [{ apiKeyName: "proof-root-key", publicKey: rootPubHex, curveType: "API_KEY_CURVE_P256" }],
      authenticators: [],
      oauthProviders: [],
    }],
    rootQuorumThreshold: 1,
    wallet: {
      walletName: "trading",
      accounts: [{
        curve: "CURVE_SECP256K1",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/60'/0'/0/0",
        addressFormat: "ADDRESS_FORMAT_ETHEREUM",
      }],
    },
  }, parentCreds, parentOrgId);
  // The root key is RETAINED (in process memory only) — it is the delegated
  // credential that stamps every sub-org activity from here on. In the real
  // claim flow this slot holds the human's passkey + short-lived server key.
  const subOrgCreds: Creds = { pub: rootPubHex, priv: rootKp.privateKey };
  console.log(`      (delegated sub-org root key retained for steps 2-6)`);
  // Live-confirmed 2026-09-29: the result field is createSubOrganizationResultV4.
  // createSubOrganizationResult. Try V4 first, fall back, report which hit.
  const v4 = so.createSubOrganizationResultV4;
  const legacy = so.createSubOrganizationResult;
  const picked = v4 ?? legacy;
  const resultField = v4 ? "createSubOrganizationResultV4" : "createSubOrganizationResult";
  const subOrgId: string | undefined = picked?.subOrganizationId;
  const walletId: string | undefined = picked?.wallet?.walletId;
  const address: string | undefined = picked?.wallet?.addresses?.[0];
  if (!subOrgId || !walletId || !address) {
    throw new Error(
      `sub-org result missing fields (tried ${resultField}): ${JSON.stringify(so).slice(0, 400)}`
    );
  }
  created.wallets.push(walletId);
  console.log(`      sub-org ${trunc(subOrgId)}  wallet ${trunc(walletId)}  address ${address}`);
  console.log(`      (result field used: ${resultField})`);

  console.log("[2/6] Sub-org ROOT key -> scoped agent user IN the sub-org…");
  const agentKp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = agentKp.publicKey.export({ format: "jwk" }) as any;
  const agentPubHex = compressedPubHex(jwk.x, jwk.y);
  const u = await call("/public/v1/submit/create_users", "ACTIVITY_TYPE_CREATE_USERS_V4", {
    users: [{
      userName: "taap-suborg-proof-agent",
      userTags: [],
      apiKeys: [{ apiKeyName: "proof-agent-key", publicKey: agentPubHex, curveType: "API_KEY_CURVE_P256" }],
      authenticators: [],
      oauthProviders: [],
    }],
  }, subOrgCreds, subOrgId);
  const agentUserId: string = u.createUsersResult.userIds[0];
  if (!agentUserId) throw new Error("agent userId missing from response");
  created.users.push(agentUserId);
  const agentCreds: Creds = { pub: agentPubHex, priv: agentKp.privateKey };
  console.log(`      agent user ${trunc(agentUserId)} (targeted via organizationId=${trunc(subOrgId)})`);

  console.log("[3/6] Sub-org ROOT key -> 7 Design-B policies IN the sub-org…");
  const defs = buildDesignBPolicies({
    chains: [1, 57073, 4663],
    routers: [ROUTER],
    agentUserId,
    namePrefix: "taap-proof-suborg",
  });
  const policyIds: string[] = [];
  for (const d of defs) {
    const p = await call("/public/v1/submit/create_policy", "ACTIVITY_TYPE_CREATE_POLICY_V3", {
      policyName: d.policyName,
      effect: d.effect,
      consensus: d.consensus,
      condition: d.condition,
      notes: d.notes,
    }, subOrgCreds, subOrgId);
    const pid: string = p.createPolicyResult.policyId;
    if (!pid) throw new Error(`policyId missing for ${d.policyName}`);
    created.policies.push(pid);
    policyIds.push(pid);
    console.log(`      ${d.effect === "EFFECT_DENY" ? "DENY" : "ALLOW"} ${d.policyName}`);
  }
  console.log("      waiting 15s for policy propagation…");
  if (!opts.skipDelays) await sleep(15000);

  const trySign = (dataHex: string, to: string, value: bigint) =>
    call("/public/v1/submit/sign_transaction", "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", {
      signWith: address,
      unsignedTransaction: unsignedTx(to, value, dataHex),
      type: "TRANSACTION_TYPE_ETHEREUM",
    }, agentCreds, subOrgId);

  const expectDeny = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      verdict(name, false, "was SIGNED — policy did not stop it.");
    } catch (e: any) {
      verdict(name, /polic|denied/i.test(e.message), `denied: ${e.message.slice(0, 200)}`);
    }
  };
  const expectSign = async (name: string, fn: () => Promise<any>) => {
    try {
      const r = await fn();
      const s = r.signTransactionResult?.signedTransaction as string | undefined;
      const ok = !!s && /^(0x)?[0-9a-fA-F]{20,}$/.test(s);
      verdict(name, ok, s ? `signed ${s.slice(0, 18)}…` : "no signedTransaction in result");
    } catch (e: any) {
      verdict(name, false, `denied unexpectedly: ${e.message.slice(0, 200)}`);
    }
  };

  console.log("[4/6] A. agent signs router-shaped swap via the SUB-ORG wallet — expect SIGNED…");
  await expectSign("A. sub-org router swap signed", () => trySign("0xabcdef12", ROUTER, 0n));

  console.log("[5/6] B. agent signs plain native transfer via the SUB-ORG wallet — expect POLICY DENY…");
  await expectDeny("B. sub-org native transfer denied", () => trySign("0x", EOA, 1n));

  console.log("\n== Result ==");
  if (failures === 0) {
    console.log("ALL GREEN: delegated-root pattern works — the sub-org's own root key provisions the agent user + Design-B policies, and the agent key signs swaps only.");
  } else {
    console.log(`${failures} check(s) FAILED — paste this whole output back to 402 Manager.`);
  }

  console.log("\n[6/6] Cleaning up test objects (best effort)…");
  for (const pid of created.policies) {
    try { await call("/public/v1/submit/delete_policy", "ACTIVITY_TYPE_DELETE_POLICY", { policyId: pid }, subOrgCreds, subOrgId); console.log(`      deleted policy ${trunc(pid)}`); }
    catch (e: any) { console.log(`      left policy ${trunc(pid)} (delete in dashboard): ${e.message.slice(0, 120)}`); }
  }
  for (const uid of created.users) {
    try { await call("/public/v1/submit/delete_users", "ACTIVITY_TYPE_DELETE_USERS", { userIds: [uid] }, subOrgCreds, subOrgId); console.log(`      deleted user ${trunc(uid)}`); }
    catch (e: any) { console.log(`      left user ${trunc(uid)} (delete in dashboard): ${e.message.slice(0, 120)}`); }
  }
  for (const wid of created.wallets) {
    try { await call("/public/v1/submit/delete_wallets", "ACTIVITY_TYPE_DELETE_WALLETS", { walletIds: [wid], deleteWithoutExport: true }, subOrgCreds, subOrgId); console.log(`      deleted wallet ${trunc(wid)}`); }
    catch (e: any) { console.log(`      left wallet ${trunc(wid)} (delete in dashboard): ${e.message.slice(0, 120)}`); }
  }
  // Sub-org deletion, stamped by its OWN root key — should SUCCEED (the
  // deleter is a root user in the sub-organization being deleted).
  let subOrgDeleted = false;
  let subOrgDeleteError: string | null = null;
  try {
    await call("/public/v1/submit/delete_sub_organization", "ACTIVITY_TYPE_DELETE_SUB_ORGANIZATION", { deleteWithoutExport: true }, subOrgCreds, subOrgId);
    subOrgDeleted = true;
    console.log(`      deleted sub-org ${trunc(subOrgId)} (by its own root key)`);
  } catch (e: any) {
    subOrgDeleteError = e.message.slice(0, 200);
    console.log(`      sub-org ${trunc(subOrgId)} NOT deleted: ${subOrgDeleteError}`);
  }
  console.log("Done. The root and agent keypairs were ephemeral — they only ever existed in this process's memory.");

  return { failures, subOrgId, walletId, address, agentUserId, policyIds, resultField, subOrgDeleted, subOrgDeleteError };
}

async function main() {
  const { org, pub, privHex } = await loadEnv();
  const parentCreds: Creds = { pub, priv: importPrivKey(privHex) };
  const r = await runFlow(makeLiveCall(), parentCreds, org);
  if (r.failures > 0) process.exitCode = 1;
}

// ---------------- self-test (no network): flow logic with a mock transport ----------------
async function selfTest() {
  console.log("== self-test (no network) ==\n");
  let bad = 0;
  const assert = (name: string, cond: boolean, extra?: string) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
    if (!cond) bad++;
  };

  const calls: { path: string; activityType: string; params: any; orgId: string; credsPub: string }[] = [];
  let policyN = 0;
  const mock: TkCall = async (path, activityType, params, creds, orgId) => {
    calls.push({ path, activityType, params, orgId, credsPub: creds.pub });
    switch (activityType) {
      case "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4":
        return { createSubOrganizationResultV4: { subOrganizationId: "suborg-test", wallet: { walletId: "w-test", addresses: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] } } };
      case "ACTIVITY_TYPE_CREATE_USERS_V4":
        return { createUsersResult: { userIds: ["u-test"] } };
      case "ACTIVITY_TYPE_CREATE_POLICY_V3":
        return { createPolicyResult: { policyId: `p-test-${++policyN}` } };
      case "ACTIVITY_TYPE_SIGN_TRANSACTION_V2": {
        // Router-shaped swap (unsigned tx embeds the router address) -> signed
        // WITHOUT 0x prefix (exercises the fixed assertion). Anything else ->
        // policy denial.
        const unsigned: string = params.unsignedTransaction as string;
        const isRouterSwap = unsigned.includes(ROUTER.slice(2).toLowerCase());
        if (isRouterSwap) return { signTransactionResult: { signedTransaction: "02f87082" + "ab".repeat(32) } };
        throw new Error("/public/v1/submit/sign_transaction -> HTTP 403: policy denied");
      }
      case "ACTIVITY_TYPE_DELETE_POLICY":
      case "ACTIVITY_TYPE_DELETE_USERS":
      case "ACTIVITY_TYPE_DELETE_WALLETS":
        return {};
      case "ACTIVITY_TYPE_DELETE_SUB_ORGANIZATION":
        return {};
      default:
        throw new Error(`unexpected activity ${activityType}`);
    }
  };

  const parentCreds: Creds = { pub: "parent-pub", priv: null };
  const r = await runFlow(mock, parentCreds, "parent-org-test", { skipDelays: true });
  // The sub-org root key the flow registered at creation:
  const subOrgRootPub: string = calls.find(
    (c) => c.activityType === "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4"
  )!.params.rootUsers[0].apiKeys[0].publicKey;
  assert("flow completes with 0 check failures", r.failures === 0);
  assert("used createSubOrganizationResultV4 field", r.resultField === "createSubOrganizationResultV4");

  const subOrgCall = calls.find((c) => c.activityType === "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4")!;
  assert("sub-org created in the PARENT org", subOrgCall.orgId === "parent-org-test");
  assert("sub-org params: ≥1 root user (400s without), quorum 1, embedded wallet",
    Array.isArray(subOrgCall.params.rootUsers) && subOrgCall.params.rootUsers.length >= 1 &&
    /^[0-9a-f]{66}$/.test(subOrgCall.params.rootUsers[0].apiKeys[0].publicKey) &&
    Array.isArray(subOrgCall.params.rootUsers[0].authenticators) &&
    Array.isArray(subOrgCall.params.rootUsers[0].oauthProviders) &&
    subOrgCall.params.rootQuorumThreshold === 1 &&
    subOrgCall.params.wallet?.walletName === "trading" &&
    subOrgCall.params.wallet?.accounts?.[0]?.path === "m/44'/60'/0'/0/0");
  assert("sub-org create hits /public/v1/submit/create_sub_organization",
    subOrgCall.path === "/public/v1/submit/create_sub_organization");

  const userCall = calls.find((c) => c.activityType === "ACTIVITY_TYPE_CREATE_USERS_V4")!;
  assert("agent user targeted INTO the sub-org via organizationId override", userCall.orgId === "suborg-test");
  assert("agent key is compressed P-256 hex", /^[0-9a-f]{66}$/.test(userCall.params.users[0].apiKeys[0].publicKey));

  const policyCalls = calls.filter((c) => c.activityType === "ACTIVITY_TYPE_CREATE_POLICY_V3");
  assert("all 7 policies created", policyCalls.length === 7);
  assert("all 7 policies targeted INTO the sub-org", policyCalls.every((c) => c.orgId === "suborg-test"));
  assert("7 policy ids collected", r.policyIds.length === 7);

  const signCalls = calls.filter((c) => c.activityType === "ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
  assert("both checks signed via the sub-org wallet address",
    signCalls.length === 2 && signCalls.every((c) => c.params.signWith === "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  assert("sign calls targeted at the sub-org", signCalls.every((c) => c.orgId === "suborg-test"));

  assert("cleanup deleted all 7 policies in the sub-org",
    calls.filter((c) => c.activityType === "ACTIVITY_TYPE_DELETE_POLICY").length === 7 &&
    calls.filter((c) => c.activityType === "ACTIVITY_TYPE_DELETE_POLICY").every((c) => c.orgId === "suborg-test"));
  assert("cleanup deleted the agent user and wallet in the sub-org",
    calls.filter((c) => c.activityType === "ACTIVITY_TYPE_DELETE_USERS").length === 1 &&
    calls.filter((c) => c.activityType === "ACTIVITY_TYPE_DELETE_WALLETS").length === 1);
  assert("sub-org creation stamped by the PARENT key",
    calls.find((c) => c.activityType === "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4")!.credsPub === "parent-pub");
  assert("agent user + all 7 policies stamped by the SUB-ORG ROOT key, not the parent",
    [userCall, ...policyCalls].every((c) => c.credsPub === subOrgRootPub) &&
    userCall.credsPub !== "parent-pub");
  assert("cleanup + sub-org delete stamped by the SUB-ORG ROOT key",
    calls.filter((c) => c.activityType.startsWith("ACTIVITY_TYPE_DELETE_")).every((c) => c.credsPub === subOrgRootPub));
  assert("sub-org deleted by its own root key", r.subOrgDeleted === true && r.subOrgDeleteError === null);

  // Fallback: legacy result field name still works.
  const mockLegacy: TkCall = async (path, activityType, params, creds, orgId) => {
    if (activityType === "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4") {
      return { createSubOrganizationResult: { subOrganizationId: "suborg-legacy", wallet: { walletId: "w-legacy", addresses: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] } } };
    }
    return mock(path, activityType, params, creds, orgId);
  };
  const r2 = await runFlow(mockLegacy, parentCreds, "parent-org-test", { skipDelays: true });
  assert("legacy createSubOrganizationResult field falls back cleanly",
    r2.resultField === "createSubOrganizationResult" && r2.failures === 0);

  console.log(bad ? "\nSELF-TEST FAILED" : "\nSELF-TEST ALL GREEN");
  if (bad) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) {
  selfTest().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
} else {
  main().catch((e) => { console.error(`\nFATAL: ${e.message}`); process.exit(1); });
}
