/**
 * LIVE PROOF for the rewritten src/claim/turnkey.ts (delegated-root pattern).
 *
 * Unlike the earlier proofs (which reimplemented the Turnkey calls inline),
 * this script exercises the ACTUAL production code path:
 *   createProvisioner({ mode: 'live', signer })
 *     -> provisionWallet -> provisionAgentKey -> agent signing checks
 *     -> teardownSubOrg
 *
 * What it does (all against YOUR Turnkey org, all test objects deleted):
 *   [1/5] provisionWallet — parent credential creates the sub-org ONCE.
 *   [2/5] provisionAgentKey — agent user + 7 Design-B policies, stamped by the
 *         sub-org's own root key.
 *   [3/5] Agent signs a router-shaped swap via the sub-org wallet — expect SIGNED.
 *   [4/5] Agent signs a plain native transfer — expect POLICY DENY.
 *   [5/5] teardownSubOrg — policies, agent user, wallet, sub-org deleted.
 *
 * Skipped: registerPasskey needs a REAL WebAuthn attestation from a human
 * ceremony (readiness item #3). Its request shape is covered offline by
 * test/claim-live-shapes.test.ts.
 *
 * Run on a machine holding the Turnkey credential (key never leaves it):
 *   cd ~/workspace/402 && npx tsx scripts/turnkey-claim-provisioner-live-proof/proof.ts
 */
import { generateKeyPairSync } from "node:crypto";
import { createInterface } from "node:readline";
import { TurnkeySigner } from "../../src/taap/signer.js";
import { createProvisioner } from "../../src/claim/turnkey.js";

const ROUTER = "0x1111111111111111111111111111111111111111"; // dummy approved router
const EOA = "0x3333333333333333333333333333333333333333"; // dummy transfer target

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}
function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
const trunc = (s: string) => (s.length > 14 ? s.slice(0, 8) + "…" + s.slice(-4) : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compressedPubHex(kp: { publicKey: any }): string {
  const jwk = kp.publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  return ((y[y.length - 1] & 1) === 0 ? "02" : "03") + x.toString("hex");
}
function privHex(kp: { privateKey: any }): string {
  const jwk = kp.privateKey.export({ format: "jwk" }) as { d?: string };
  return Buffer.from(jwk.d!, "base64url").toString("hex");
}

async function loadEnv() {
  let org = process.env.TURNKEY_ORG_ID?.trim() || "";
  let pub = process.env.TURNKEY_API_PUBLIC_KEY?.replace(/^0x/, "").trim();
  let privHexVal = process.env.TURNKEY_API_PRIVATE_KEY?.replace(/^0x/, "").trim();
  if (!org) org = (await prompt("Turnkey org ID: ")).trim();
  if (!pub) pub = (await prompt("API public key (paste exactly as the dashboard shows it): ")).replace(/^0x/, "");
  if (!privHexVal) privHexVal = (await prompt("API private key (the one shown once at creation): ")).replace(/^0x/, "");
  if (!org || !pub || !/^[0-9a-fA-F]{64}$/.test(privHexVal || "")) {
    fail("Need all three: TURNKEY_ORG_ID, API public key, and the 64-char hex API private key.");
  }
  return { org, pub: pub!, privHex: privHexVal! };
}

async function main() {
  const { org, pub, privHex: priv } = await loadEnv();
  let failures = 0;
  const verdict = (name: string, ok: boolean, detail?: string) => {
    console.log(`      ${ok ? "PASS" : "FAIL"} — ${name}${detail ? `\n      ${detail}` : ""}`);
    if (!ok) failures++;
  };

  console.log("== turnkey.ts live proof (delegated-root, production code path) ==\n");

  // Parent signer — used by the provisioner exactly once (sub-org creation).
  const parentSigner = new TurnkeySigner({ orgId: org, apiPublicKey: pub, apiPrivateKeyHex: priv });
  const provisioner = createProvisioner({ mode: "live", signer: parentSigner });

  console.log("[1/5] provisionWallet (parent credential -> CREATE_SUB_ORGANIZATION_V4)…");
  const w = await provisioner.provisionWallet("live-proof");
  console.log(`      sub-org ${trunc(w.subOrgId)}  wallet ${trunc(w.walletId)}  address ${w.address}`);
  verdict("sub-org + wallet provisioned via the real code path",
    !!w.subOrgId && !!w.walletId && /^0x[0-9a-fA-F]{40}$/.test(w.address));

  console.log("[2/5] provisionAgentKey (sub-org root key -> agent user + 7 policies)…");
  const agentKp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const agentPub = compressedPubHex(agentKp);
  const { userId: agentUserId, policyIds } = await provisioner.provisionAgentKey(w, agentPub, {
    chains: [57073],
    routers: [ROUTER],
    perTradeCapWei: "0",
  });
  console.log(`      agent user ${trunc(agentUserId)}  policies: ${policyIds.length}`);
  verdict("agent user + 7 Design-B policies provisioned", !!agentUserId && policyIds.length === 7);
  console.log("      waiting 15s for policy propagation…");
  await sleep(15000);

  // Agent signer — scoped credential, sub-org voter.
  const agentSigner = new TurnkeySigner({
    orgId: w.subOrgId,
    apiPublicKey: agentPub,
    apiPrivateKeyHex: privHex(agentKp),
  });
  const swapTx = {
    chainId: 57073, nonce: "0x0",
    maxFeePerGas: "0x5f5e100", maxPriorityFeePerGas: "0x3b9aca00", gas: "0x5208",
    to: ROUTER, value: "0x0", data: "0xabcdef12",
  };
  const transferTx = { ...swapTx, to: EOA, value: "0x1", data: "0x" };

  console.log("[3/5] Agent signs router-shaped swap — expect SIGNED…");
  try {
    const signed = await agentSigner.signTransaction(w.address, swapTx);
    verdict("router swap signed", /^0x02[0-9a-fA-F]+$/.test(signed), `signed ${signed.slice(0, 18)}…`);
  } catch (e) {
    verdict("router swap signed", false, (e as Error).message.slice(0, 200));
  }

  console.log("[4/5] Agent signs plain native transfer — expect POLICY DENY…");
  try {
    await agentSigner.signTransaction(w.address, transferTx);
    verdict("native transfer denied", false, "transfer was SIGNED — policy failure!");
  } catch (e) {
    const msg = (e as Error).message;
    const denied = /403|sufficient permissions|policy/i.test(msg);
    verdict("native transfer denied", denied, `denied: ${msg.slice(0, 160)}`);
  }

  console.log("\n[5/5] teardownSubOrg (policies, agent user, wallet, sub-org)…");
  const { errors } = await provisioner.teardownSubOrg(w, { agentUserId, policyIds });
  verdict("cleanup complete", errors.length === 0,
    errors.length ? errors.join("\n      ") : "all test objects deleted");

  console.log("\n== Result ==");
  if (failures > 0) {
    console.log(`FAILURES: ${failures} — see above.`);
    process.exit(1);
  }
  console.log("ALL GREEN: the rewritten turnkey.ts provisions, enforces, and tears down live.");
  console.log("Note: registerPasskey was not exercised (needs a real WebAuthn ceremony — item #3).");
  console.log("Done. All keypairs were ephemeral — they only ever existed in this process's memory.");
}

main().catch((e) => fail((e as Error).message));
