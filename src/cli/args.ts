/** Minimal `--key value` / `--flag` CLI arg parser. */
export function parseArgs(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = raw[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function required(
  args: Record<string, string | boolean>,
  name: string,
): string {
  const v = args[name];
  if (typeof v !== 'string' || !v) {
    console.error(`missing required --${name}`);
    process.exit(1);
  }
  return v;
}

export function optional(
  args: Record<string, string | boolean>,
  name: string,
  fallback: string,
): string {
  const v = args[name];
  return typeof v === 'string' && v ? v : fallback;
}

export function flag(args: Record<string, string | boolean>, name: string): boolean {
  return args[name] === true;
}

/** Read a hex private key from env. Refuses to read from argv — keys never go in chat or shell history. */
export function keyFromEnv(varName: string): `0x${string}` {
  const v = process.env[varName];
  if (!v) {
    console.error(
      `missing ${varName} in environment. Ask the founder to provide it via the Secure Vault — never paste keys in chat.`,
    );
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(v.trim())) {
    console.error(`${varName} is not a valid 0x-prefixed 32-byte private key`);
    process.exit(1);
  }
  return v.trim() as `0x${string}`;
}
