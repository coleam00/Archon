import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

if (process.env.INPUTS_ACTION === 'locate') {
  console.log(JSON.stringify({ path: import.meta.path }));
  process.exit(0);
}

const separator = process.argv.indexOf('--', 2);
if (separator !== 3 || process.argv.length < 5) {
  console.error('usage: capture-command.ts OUTPUT_PREFIX -- COMMAND [ARG ...]');
  process.exit(2);
}

const prefix = resolve(process.argv[2]);
mkdirSync(dirname(prefix), { recursive: true });
const completed = Bun.spawnSync(process.argv.slice(separator + 1), {
  stdout: 'pipe',
  stderr: 'pipe',
});
writeFileSync(`${prefix}.stdout`, completed.stdout);
writeFileSync(`${prefix}.stderr`, completed.stderr);
writeFileSync(`${prefix}.exit.json`, `${JSON.stringify({ exit_code: completed.exitCode })}\n`, 'utf8');
process.exit(completed.exitCode);
