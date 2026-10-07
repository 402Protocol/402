import { readFileSync, writeFileSync } from 'node:fs';
const artifact = JSON.parse(readFileSync(new URL('../out/Four02JobEscrow.sol/Four02JobEscrow.json', import.meta.url), 'utf8'));
const target = new URL('../packages/job-escrow/src/abi.ts', import.meta.url);
const source = '// Generated from Four02JobEscrow.sol. Run forge build then node scripts/sync-job-escrow-abi.mjs.\n'
  + `export const jobEscrowAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== source) throw new Error('Job escrow ABI drift; regenerate from the compiled contract');
  console.log('PASS: job SDK ABI matches compiled contract');
} else writeFileSync(target, source);
