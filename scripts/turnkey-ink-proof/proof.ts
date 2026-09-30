#!/usr/bin/env npx tsx
/**
 * Turnkey x Ink proof — RUN ON YOUR OWN MACHINE.
 * Your Turnkey API private key never leaves this process.
 *
 * Proves with live Turnkey API calls:
 *  1. Turnkey provisions a fresh EVM wallet (address valid on every EVM chain, incl. Ink).
 *  2. A scoped, non-root "agent" API key CAN sign an Ink-mainnet transaction
 *     (chain ID 57073 = 0xdead) via SIGN_TRANSACTION_V2 when policy allows it.
 *  3. The same agent key is DENIED on SIGN_RAW_PAYLOAD_V2
 *     (the bypass that would let it dodge policy).
 *
 * Nothing is broadcast. No funds move. The only network calls are to api.turnkey.com.
 * This script never prints secrets — only truncated IDs and pass/fail.
 *
 * Env:
 *   TURNKEY_ORG_ID            e.g. 4ccacf1d-849a-4a8c-b251-159d4cb01783
 *   TURNKEY_API_PUBLIC_KEY    root API key public key — paste EXACTLY as the dashboard shows it
 *                                 (usually the 66-char compressed hex form)
 *   TURNKEY_API_PRIVATE_KEY   root API key private key (hex, shown once at creation)
 *
 * Run:  npx tsx proof.ts
 */

import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { createInterface } from "node:readline";

const API = "https://api.turnkey.com";
const INK_CHAIN_ID = 57073n; // 0xdead — Ink mainnet

let ORG = "";

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function loadEnv() {
  // Env vars win if set; otherwise ask interactively (nothing is saved anywhere).
  let org = process.env.TURNKEY_ORG_ID?.trim() || "4ccacf1d-849a-4a8c-b251-159d4cb01783";
  let pub = process.env.TURNKEY_API_PUBLIC_KEY?.replace(/^0x/, "").trim();
  let privHex = process.env.TURNKEY_API_PRIVATE_KEY?.replace(/^0x/, "").trim();
  if (!pub) pub = (await prompt("API public key (paste exactly as the dashboard shows it): ")).replace(/^0x/, "");
  if (!privHex) privHex = (await prompt("API private key (the one shown once at creation): ")).replace(/^0x/, "");
  if (!org || !pub || !/^[0-9a-fA-F]{64}$/.test(privHex)) {
    fail("Need all three: org ID, API public key, and the 64-char hex API private key.");
  }
  return { org, pub, privHex };
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) fail(`Missing env var ${name}. See README.md.`);
  return v as string;
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const trunc = (s: string) => (s.length > 14 ? s.slice(0, 8) + "…" + s.slice(-4) : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- bytes / RLP ----------------
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
function rlpDecode(buf: Uint8Array<ArrayBufferLike>): [any, Uint8Array<ArrayBufferLike>] {
  const b0 = buf[0];
  const readLen = (pos: number, ll: number) => Number(bytesToBigInt(buf.slice(pos, pos + ll)));
  if (b0 < 0x80) return [buf.slice(0, 1), buf.slice(1)];
  if (b0 < 0xb8) { const l = b0 - 0x80; return [buf.slice(1, 1 + l), buf.slice(1 + l)]; }
  if (b0 < 0xc0) { const ll = b0 - 0xb7; const l = readLen(1, ll); return [buf.slice(1 + ll, 1 + ll + l), buf.slice(1 + ll + l)]; }
  const listBody = (start: number, l: number): [any[], Uint8Array<ArrayBufferLike>] => {
    const out: any[] = [];
    let rest: Uint8Array<ArrayBufferLike> = buf.slice(start, start + l);
    while (rest.length) { const [v, r] = rlpDecode(rest); out.push(v); rest = r; }
    return [out, buf.slice(start + l)];
  };
  if (b0 < 0xf8) return listBody(1, b0 - 0xc0);
  const ll = b0 - 0xf7;
  return listBody(1 + ll, readLen(1, ll));
}

// ---------------- Turnkey stamping (P-256 over the request body) ----------------
function importPrivKey(hex: string) {
  // SEC1 DER: SEQUENCE { INTEGER 1, OCTET STRING <32-byte scalar>, [0] { OID secp256r1 } }
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

// compressed P-256 public key (33 bytes, 02/03 prefix) from JWK x/y
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

// ---------------- main ----------------
async function main() {
  const { org, pub, privHex } = await loadEnv();
  ORG = org;
  const rootCreds = { pub, priv: importPrivKey(privHex) };
  const created = { policies: [] as string[], users: [] as string[], wallets: [] as string[] };

  console.log("== Turnkey x Ink proof ==\n");

  // 1. Provision a fresh EVM wallet (as root)
  console.log("[1/5] Creating test wallet…");
  const w = await tk("/public/v1/submit/create_wallet", "ACTIVITY_TYPE_CREATE_WALLET", {
    walletName: "taap-proof-" + Date.now().toString(36),
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

  // 2. Create a scoped, non-root "agent" user with its own API key (ephemeral, in-memory only)
  console.log("[2/5] Creating scoped agent user (fresh P-256 keypair, never saved)…");
  const agentKp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = agentKp.publicKey.export({ format: "jwk" }) as any;
  const agentPubHex = compressedPubHex(jwk.x, jwk.y);
  const u = await tk("/public/v1/submit/create_users", "ACTIVITY_TYPE_CREATE_USERS_V4", {
    users: [{
      userName: "taap-proof-agent",
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

  // 3. Lock in policies: ALLOW structured Ink signing, DENY raw payload signing
  console.log("[3/5] Creating policies (ALLOW Ink sign_transaction, DENY raw payload)…");
  const consensus = `approvers.any(user, user.id == '${agentUserId}')`;
  const p1 = await tk("/public/v1/submit/create_policy", "ACTIVITY_TYPE_CREATE_POLICY_V3", {
    policyName: "taap-proof-allow-ink-sign",
    effect: "EFFECT_ALLOW",
    consensus,
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${INK_CHAIN_ID}`,
    notes: "proof: agent may sign structured txs on Ink mainnet only",
  }, rootCreds);
  const p2 = await tk("/public/v1/submit/create_policy", "ACTIVITY_TYPE_CREATE_POLICY_V3", {
    policyName: "taap-proof-deny-raw",
    effect: "EFFECT_DENY",
    consensus,
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'`,
    notes: "proof: agent may never raw-sign (policy bypass)",
  }, rootCreds);
  created.policies.push(p1.createPolicyResult.policyId, p2.createPolicyResult.policyId);
  console.log(`      policies ${trunc(created.policies[0])}, ${trunc(created.policies[1])}`);
  console.log("      waiting 10s for policy propagation…");
  await sleep(10000);

  // 4. Agent signs an Ink-mainnet tx (expect SUCCESS)
  console.log("[4/5] Agent requests SIGN_TRANSACTION_V2 for chain 57073 (Ink) — expect SIGNED…");
  const unsignedFields: RlpIn[] = [
    intToBytes(INK_CHAIN_ID),                       // chain_id = 57073 (0xdead)
    intToBytes(0n),                                 // nonce
    intToBytes(100_000_000n),                       // max_priority_fee_per_gas
    intToBytes(1_000_000_000n),                      // max_fee_per_gas
    intToBytes(21000n),                             // gas
    hexToBytes("000000000000000000000000000000000000dEaD"), // to (burn)
    intToBytes(0n),                                 // value
    new Uint8Array(0),                              // data
    [],                                             // access_list
  ];
  const unsignedTx = "0x02" + bytesToHex(rlpEncode(unsignedFields));
  let signedTx: string | null = null;
  try {
    const s = await tk("/public/v1/submit/sign_transaction", "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", {
      signWith: address,
      unsignedTransaction: unsignedTx,
      type: "TRANSACTION_TYPE_ETHEREUM",
    }, agentCreds);
    signedTx = s.signTransactionResult.signedTransaction as string;
  } catch (e: any) {
    console.log(`      FAIL — signing was denied unexpectedly:\n      ${e.message}`);
  }
  if (signedTx) {
    // verify: parses as EIP-1559, chain_id 57073, well-formed r/s
    const raw = hexToBytes(signedTx);
    const okType = raw[0] === 0x02;
    const [fields] = rlpDecode(raw.slice(1));
    const okFields = Array.isArray(fields) && fields.length === 12;
    const okChain = okFields && bytesToBigInt(fields[0]) === INK_CHAIN_ID;
    const okSig = okFields && (fields[10] as Uint8Array).length === 32 && (fields[11] as Uint8Array).length === 32;
    if (okType && okChain && okSig) {
      console.log(`      PASS — signed. chain_id in signed tx = ${bytesToBigInt(fields[0])}, r/s well-formed.`);
    } else {
      console.log(`      FAIL — signature returned but did not verify (type=${okType} fields=${okFields} chain=${okChain} sig=${okSig}).`);
      signedTx = null;
    }
  }

  // 5. Agent tries raw payload signing (expect POLICY DENIAL)
  console.log("[5/5] Agent requests SIGN_RAW_PAYLOAD_V2 — expect DENIED…");
  let rawDenied = false;
  try {
    await tk("/public/v1/submit/sign_raw_payload", "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", {
      signWith: address,
      payload: "0x" + "ab".repeat(32),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    }, agentCreds);
    console.log("      FAIL — raw payload was SIGNED. Policy did not stop the bypass.");
  } catch (e: any) {
    if (/polic/i.test(e.message)) {
      rawDenied = true;
      console.log("      PASS — denied by policy.");
    } else {
      console.log(`      FAIL — denied, but NOT by policy (unexpected error):\n      ${e.message}`);
    }
  }

  console.log("\n== Result ==");
  if (signedTx && rawDenied) {
    console.log("ALL GREEN: Turnkey signs Ink (57073) txs under policy, and raw signing is denied.");
  } else {
    console.log("NOT GREEN — see FAIL lines above. Paste this whole output back to 402 Manager.");
    process.exitCode = 1;
  }

  // best-effort cleanup (never fails the run)
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

// ---------------- self-test (no network): verifies RLP + stamping plumbing ----------------
async function selfTest() {
  console.log("== self-test (no network) ==\n");
  const fields: RlpIn[] = [
    intToBytes(INK_CHAIN_ID), intToBytes(0n), intToBytes(100_000_000n),
    intToBytes(1_000_000_000n), intToBytes(21000n),
    hexToBytes("000000000000000000000000000000000000dEaD"),
    intToBytes(0n), new Uint8Array(0), [],
  ];
  const enc = rlpEncode(fields);
  const [dec] = rlpDecode(enc.slice(0) as Uint8Array<ArrayBufferLike>);
  const assert = (name: string, cond: boolean) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
    if (!cond) process.exitCode = 1;
  };
  assert("RLP round-trip preserves 9 fields", Array.isArray(dec) && dec.length === 9);
  assert("chain_id decodes to 57073", bytesToBigInt(dec[0] as Uint8Array) === INK_CHAIN_ID);

  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const k = kp.publicKey.export({ format: "jwk" }) as any;
  const comp = compressedPubHex(k.x, k.y);
  assert("compressed pubkey is 66 hex chars", /^[0-9a-f]{66}$/.test(comp) && /^(02|03)/.test(comp));

  const st = stamp('{"hello":"world"}', comp, kp.privateKey as any);
  const parsed = JSON.parse(Buffer.from(st, "base64url").toString("utf8"));
  assert("stamp is base64url JSON with P256 scheme",
    parsed.scheme === "SIGNATURE_SCHEME_TK_API_P256" && parsed.publicKey === comp);
  assert("stamp signature is DER hex", /^[0-9a-f]{140,150}$/.test(parsed.signature));

  console.log(process.exitCode ? "\nSELF-TEST FAILED" : "\nSELF-TEST ALL GREEN");
}

if (process.argv.includes("--self-test")) {
  selfTest().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
} else {
  main().catch((e) => { console.error(`\nFATAL: ${e.message}`); process.exit(1); });
}
