import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'test/selftest.ts',
  ...readdirSync(new URL('../test/', import.meta.url))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `test/${name}`),
];
const failed = [];

// Separate processes keep each suite's environment, mocks, and test keys isolated.
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', file], {
    cwd: root,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    failed.push(file);
    console.error(`FAILED: ${file} (${result.error?.message ?? result.signal ?? result.status})`);
  }
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed.`);
if (failed.length) {
  console.error(`Failed test files: ${failed.join(', ')}`);
  process.exitCode = 1;
}
