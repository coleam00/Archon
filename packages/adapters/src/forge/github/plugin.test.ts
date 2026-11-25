import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// The pipe is the subject. A large pull request's `pr.files` response is megabytes;
// written with `console.log`, the host received a cut-off document and reported an
// invalid response. The host reads the plugin through `node:child_process`, as here.
test('a multi-megabyte response reaches the host whole', async () => {
  const plugin = join(import.meta.dir, 'plugin.ts');
  const script = [
    `import { respond } from ${JSON.stringify(plugin)};`,
    'void process.stdout.isTTY;',
    "await respond({ payload: 'x'.repeat(3_000_000) });",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { cwd: import.meta.dir });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  expect(code).toBe(0);
  const out = Buffer.concat(chunks).toString('utf8');
  expect((JSON.parse(out) as { payload: string }).payload).toHaveLength(3_000_000);
});
