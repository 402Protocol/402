// 402 Manager identity key-holder. The private key is loaded from
// .manager.env (0600, gitignored) when present so the identity survives
// process restarts; otherwise a fresh key is generated in process memory.
// The key is never printed. It only speaks JSON over stdio:
// {cmd:'address'} | {cmd:'sign_typed_data', payload}
// | {cmd:'transfer_usdc', rpcUrl, usdc, to, amountUnits}.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, parseAbi } from 'viem';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadKey() {
  try {
    const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '.manager.env'), 'utf8');
    const m = env.match(/FOUR02_MANAGER_KEY=(0x[0-9a-fA-F]{64})/);
    if (m) return m[1];
  } catch {
    // no backup file — fall through to a fresh in-memory key
  }
  return generatePrivateKey();
}

const privateKey = loadKey();
const account = privateKeyToAccount(privateKey);

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ ok: true, address: account.address });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      out({ ok: false, error: 'bad_json' });
      continue;
    }
    try {
      if (msg.cmd === 'address') {
        out({ ok: true, address: account.address });
      } else if (msg.cmd === 'sign_typed_data') {
        const signature = await account.signTypedData(msg.payload);
        out({ ok: true, signature });
      } else if (msg.cmd === 'transfer_usdc') {
        const chain = {
          id: 57073,
          name: 'Ink',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [msg.rpcUrl] } },
        };
        const client = createWalletClient({
          account,
          chain,
          transport: http(msg.rpcUrl),
        });
        const txHash = await client.writeContract({
          address: msg.usdc,
          abi: parseAbi([
            'function transfer(address to, uint256 amount) returns (bool)',
          ]),
          functionName: 'transfer',
          args: [msg.to, BigInt(msg.amountUnits)],
        });
        out({ ok: true, txHash });
      } else {
        out({ ok: false, error: 'unknown_cmd' });
      }
    } catch (e) {
      out({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
    }
  }
});
