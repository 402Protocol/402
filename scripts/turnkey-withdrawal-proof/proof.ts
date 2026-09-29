#!/usr/bin/env npx tsx
/**
 * Turnkey Design-B withdrawal-enforcement proof — RUN ON YOUR OWN MACHINE.
 * Your Turnkey API private key never leaves this process.
 *
 * Proves with live Turnkey API calls that the policy set built by
 * src/claim/policies.ts (buildDesignBPolicies) actually enforces
 * "agent swaps only, zero transfers":
 *  A. agent signs a plain ETH transfer (1 wei)            -> expect POLICY DENY
 *  B. agent signs a router-shaped swap tx (value 0)       -> expect SIGNED
 *  C. agent signs approve(router, amount)                 -> expect SIGNED
 *  D. agent signs approve(evil, amount)                   -> expect POLICY DENY
 *  E. agent signs ERC-20 transfer()                       -> expect POLICY DENY
 *  F. agent requests SIGN_RAW_PAYLOAD_V2                  -> expect POLICY DENY
 *
 * Nothing is broadcast. No funds move (signing needs no balance). The only
 * network calls are to api.turnkey.com. This script never prints secrets —
 * only truncated IDs and pass/fail. All test objects (policies, user,
 * wallet) are deleted at the end, like scripts/turnkey-ink-proof/proof.ts.
 *
 * Env (same as the Ink proof):
 *   TURNKEY_ORG_ID
 *   TURNKEY_API_PUBLIC_KEY    root API key public key, exactly as the dashboard shows it
 *   TURNKEY_API_PRIVATE_KEY   root API key private key (hex, shown once at creation)
 *
 * Run:  npx tsx proof.ts
 * Self-test (no network, exercises the policy builder only): npx tsx proof.ts --self-test
 */

import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { createInterface } from "node:readline";
import { buildDesignBPolicies } from "../../src/claim/policies.js";

const API = "https://api.turnkey.com";
const CHAIN_ID = 57073n; // Ink mainnet, one of the mandate chains

// Dummy "approved router" and "evil" addresses for the proof mandate.
const ROUTER = "0x1111111111111111111111111111111111111111";
const EVIL = "0x000000000000000000000000000000000000dEaD";
const TOKEN = "0x2222222222222222222222222222222222222222";
const EOA = "0x3333333333333333333333333333333333333333";

let ORG = "";

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

// ---------------- bytes / RLP (same as turnkey-ink-proof) ----------------
const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hexToBytes = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

function intToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return hexToBytes(h);
}
const bytesToBigInt = (b: Uint8Array): bigint => (b.length ? BigInt("0x" + bytesToHex(b)) : 0n);

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

async function tk(path: string, activityType: string, parameters: any, creds: { pub: string; priv: any }) {
  const body = JSON.stringify({
    type: activityType,
    organizationId: ORG,
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
}

// ---------------- tx builders ----------------
function pad32(hexNo0x: string): string {
  return hexNo0x.toLowerCase().padStart(64, "0");
}
function approveCalldata(spender: string, amount: bigint): string {
  return "0x095ea7b3" + pad32(spender.replace(/^0x/, "")) + pad32(amount.toString(16));
}
function transferCalldata(to: string, amount: bigint): string {
  return "0xa9059cbb" + pad32(to.replace(/^0x/, "")) + pad32(amount.toString(16));
}
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

// ---------------- main ----------------
async function main() {
  const { org, pub, privHex } = await loadEnv();
  ORG = org;
  const rootCreds = { pub, priv: importPrivKey(privHex) };
  const created = { policies: [] as string[], users: [] as string[], wallets: [] as string[] };
  let failures = 0;
  const verdict = (name: string, ok: boolean, detail?: string) => {
    console.log(`      ${ok ? "PASS" : "FAIL"} — ${name}${detail ? `\n      ${detail}` : ""}`);
    if (!ok) failures++;
  };

  console.log("== Turnkey Design-B withdrawal-enforcement proof ==\n");

  console.log("[1/8] Creating test wallet…");
  const w = await tk("/public/v1/submit/create_wallet", "ACTIVITY_TYPE_CREATE_WALLET", {
    walletName: "taap-designb-proof-" + Date.now().toString(36),
    accounts: [{
      curve: "CURVE_SECP256K1",
      pathFormat: "PATH_FORMAT_BIP32",
      path: "m/44'/60'/0'/0/0",
      addressFormat: "ADDRESS_FORMAT_ETHEREUM",
    }],
  }, rootCreds);
  const walletId: string = w.createWalletResult.walletId;
  const address: string = w.createWalletResult.addresses[0];
  created.wallets.push(walletId);
  console.log(`      wallet ${trunc(walletId)}  address ${address}`);

  console.log("[2/8] Creating scoped agent user (fresh P-256 keypair, never saved)…");
  const agentKp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = agentKp.publicKey.export({ format: "jwk" }) as any;
  const agentPubHex = compressedPubHex(jwk.x, jwk.y);
  const u = await tk("/public/v1/submit/create_users", "ACTIVITY_TYPE_CREATE_USERS_V4", {
    users: [{
      userName: "taap-designb-proof-agent",
      userTags: [],
      apiKeys: [{ apiKeyName: "proof-agent-key", publicKey: agentPubHex, curveType: "API_KEY_CURVE_P256" }],
      authenticators: [],
      oauthProviders: [],
    }],
  }, rootCreds);
  const agentUserId: string = u.createUsersResult.userIds[0];
  created.users.push(agentUserId);
  const agentCreds = { pub: agentPubHex, priv: agentKp.privateKey };
  console.log(`      agent user ${trunc(agentUserId)}`);

  console.log("[3/8] Building Design-B policies from src/claim/policies.ts and creating them…");
  const defs = buildDesignBPolicies({
    chains: [1, 57073, 4663],
    routers: [ROUTER],
    agentUserId,
    namePrefix: "taap-proof-designb",
  });
  for (const d of defs) {
    const p = await tk("/public/v1/submit/create_policy", "ACTIVITY_TYPE_CREATE_POLICY_V3", {
      policyName: d.policyName,
      effect: d.effect,
      consensus: d.consensus,
      condition: d.condition,
      notes: d.notes,
    }, rootCreds);
    created.policies.push(p.createPolicyResult.policyId);
    console.log(`      ${d.effect === "EFFECT_DENY" ? "DENY" : "ALLOW"} ${d.policyName}`);
  }
  console.log("      waiting 15s for policy propagation…");
  await sleep(15000);

  const trySign = async (dataHex: string, to: string, value: bigint) => {
    return tk("/public/v1/submit/sign_transaction", "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", {
      signWith: address,
      unsignedTransaction: unsignedTx(to, value, dataHex),
      type: "TRANSACTION_TYPE_ETHEREUM",
    }, agentCreds);
  };
  const expectDeny = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      verdict(name, false, "was SIGNED — policy did not stop it.");
    } catch (e: any) {
      // Explicit DENY and implicit-deny (no matching policy) both surface
      // as policy denials; anything else is a FAIL with the raw message.
      verdict(name, /polic|denied/i.test(e.message), `denied: ${e.message.slice(0, 200)}`);
    }
  };
  const expectSign = async (name: string, fn: () => Promise<any>) => {
    try {
      const r = await fn();
      const s = r.signTransactionResult?.signedTransaction as string | undefined;
      verdict(name, !!s && s.startsWith("0x"), s ? `signed ${s.slice(0, 18)}…` : "no signedTransaction in result");
    } catch (e: any) {
      verdict(name, false, `denied unexpectedly: ${e.message.slice(0, 200)}`);
    }
  };

  console.log("[4/8] A. plain ETH transfer (1 wei to EOA) — expect POLICY DENY…");
  await expectDeny("A. native transfer denied", () => trySign("0x", EOA, 1n));

  console.log("[5/8] B. router-shaped swap (value 0 to approved router) — expect SIGNED…");
  await expectSign("B. router swap signed", () => trySign("0xabcdef12", ROUTER, 0n));

  console.log("[6/8] C. approve(approved router, amount) — expect SIGNED…");
  await expectSign("C. scoped approval signed", () => trySign(approveCalldata(ROUTER, 1_000_000n), TOKEN, 0n));

  console.log("[7/8] D. approve(evil spender, amount) — expect POLICY DENY…");
  await expectDeny("D. evil-spender approval denied", () => trySign(approveCalldata(EVIL, 1_000_000n), TOKEN, 0n));

  console.log("       E. ERC-20 transfer() — expect POLICY DENY…");
  await expectDeny("E. token transfer denied", () => trySign(transferCalldata(EOA, 1_000_000n), TOKEN, 0n));

  console.log("[8/8] F. SIGN_RAW_PAYLOAD_V2 — expect POLICY DENY…");
  await expectDeny("F. raw payload denied", () =>
    tk("/public/v1/submit/sign_raw_payload", "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", {
      signWith: address,
      payload: "0x" + "ab".repeat(32),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    }, agentCreds));

  console.log("\n== Result ==");
  if (failures === 0) {
    console.log("ALL GREEN: Design B holds — the agent key signs swaps and scoped approvals only; every transfer shape is denied by policy.");
  } else {
    console.log(`${failures} check(s) FAILED — paste this whole output back to 402 Manager.`);
    process.exitCode = 1;
  }

  console.log("\nCleaning up test objects (best effort)…");
  for (const pid of created.policies) {
    try { await tk("/public/v1/submit/delete_policy", "ACTIVITY_TYPE_DELETE_POLICY", { policyId: pid }, rootCreds); console.log(`      deleted policy ${trunc(pid)}`); }
    catch (e: any) { console.log(`      left policy ${trunc(pid)} (delete in dashboard): ${e.message.slice(0, 120)}`); }
  }
  for (const uid of created.users) {
    try { await tk("/public/v1/submit/delete_users", "ACTIVITY_TYPE_DELETE_USERS", { userIds: [uid] }, rootCreds); console.log(`      deleted user ${trunc(uid)}`); }
    catch (e: any) { console.log(`      left user ${trunc(uid)} (delete in dashboard): ${e.message.slice(0, 120)}`); }
  }
  for (const wid of created.wallets) {
    try { await tk("/public/v1/submit/delete_wallets", "ACTIVITY_TYPE_DELETE_WALLETS", { walletIds: [wid], deleteWithoutExport: true }, rootCreds); console.log(`      deleted wallet ${trunc(wid)}`); }
    catch (e: any) { console.log(`      left wallet ${trunc(wid)} (delete in dashboard): ${e.message.slice(0, 120)}`); }
  }
  console.log("Done. The agent keypair was ephemeral — it only ever existed in this process's memory.");
}

// ---------------- self-test (no network): builder + calldata shapes ----------------
async function selfTest() {
  console.log("== self-test (no network) ==\n");
  let bad = 0;
  const assert = (name: string, cond: boolean) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
    if (!cond) bad++;
  };
  const defs = buildDesignBPolicies({ chains: [1, 57073, 4663], routers: [ROUTER], agentUserId: "u-test" });
  assert("builder returns 7 policies", defs.length === 7);

  // The proof's approve() calldata must satisfy the builder's own slices:
  // data[0..10] (exclusive) == '0x095ea7b3', data[34..74] (exclusive) == router bare.
  const data = approveCalldata(ROUTER, 1_000_000n);
  assert("approve calldata starts with 095ea7b3 selector", data.slice(0, 10) === "0x095ea7b3");
  assert("approve spender sits at chars 34..74", data.slice(34, 74) === ROUTER.slice(2).toLowerCase());
  assert("approve amount word is 64 hex chars", data.slice(74).length === 64);
  const allow = defs.find((d) => d.policyName.endsWith("-allow-approvals"))!;
  assert("approval policy embeds the bare router", allow.condition.includes(`'${ROUTER.slice(2).toLowerCase()}'`));

  const tx = unsignedTx(ROUTER, 0n, "0xabcdef12");
  assert("unsigned swap tx builds", tx.startsWith("0x02") && tx.length > 20);
  console.log(bad ? "\nSELF-TEST FAILED" : "\nSELF-TEST ALL GREEN");
  if (bad) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) {
  selfTest().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
} else {
  main().catch((e) => { console.error(`\nFATAL: ${e.message}`); process.exit(1); });
}
