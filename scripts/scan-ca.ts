/** One-off CA scan: inspectToken with curl-shimmed fetch (VM egress quirk). */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectToken } from '../src/taap/tokens.js';
const execFileAsync = promisify(execFile);

async function curlFetch(url: unknown, init?: { headers?: Record<string, string> }): Promise<Response> {
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '25', String(url)];
  for (const [k, v] of Object.entries(init?.headers ?? {})) args.push('-H', `${k}: ${v}`);
  const { stdout } = await execFileAsync('curl', args);
  const idx = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(idx + 1).trim());
  const body = stdout.slice(0, idx);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body } as unknown as Response;
}

const ca = process.argv[2];
const chain = process.argv[3]; // optional
const r = await inspectToken(ca, chain, curlFetch as unknown as typeof fetch);
console.log(JSON.stringify(r, null, 1));
