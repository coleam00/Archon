import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
export {};
const modeAt = args.indexOf('--mode');
const mode = modeAt >= 0 ? args[modeAt + 1] : 'ok';
const nameAt = args.indexOf('--name');
const name = nameAt >= 0 ? args[nameAt + 1] : 'test';
const command = args.find(value => value === 'metadata' || value === 'op');

if (command === 'metadata') {
  if (process.env.ARCHON_FORGE_TOKEN) throw new Error('metadata received credential');
  if (mode === 'bad-metadata') process.stdout.write('{');
  else
    process.stdout.write(
      JSON.stringify({
        protocol: mode === 'bad-protocol' ? 2 : 1,
        name,
        version: '1.0.0',
        forge: 'test',
        hosts: ['forge.example'],
        capabilities: mode === 'unsupported' ? [] : ['resolve', 'checks.state'],
        token_env: mode === 'token' ? ['TEST_FORGE_TOKEN'] : [],
      })
    );
  process.exit(0);
}

if (mode === 'environment') {
  process.stdout.write(
    JSON.stringify({
      unrelated: process.env.UNRELATED_SECRET ?? null,
      token: process.env.ARCHON_FORGE_TOKEN ? 'present' : 'absent',
      original: process.env.TEST_FORGE_TOKEN ?? null,
    })
  );
} else if (mode === 'hang-child') {
  const pidFileAt = args.indexOf('--pid-file');
  const child = spawn(process.execPath, [join(import.meta.dir, 'heartbeat-process.ts')], {
    stdio: 'ignore',
    detached: process.platform === 'win32',
  });
  if (pidFileAt >= 0 && child.pid !== undefined)
    writeFileSync(args[pidFileAt + 1], String(child.pid));
  setInterval(Date.now, 1_000);
} else if (mode === 'hang') {
  setInterval(Date.now, 1_000);
} else if (mode === 'large') {
  process.stdout.write('x'.repeat(4096));
} else {
  const input = (await Bun.stdin.json()) as { operationId: string; op: string; remote?: string };
  if (mode === 'token-error') {
    process.stderr.write(`failed with ${process.env.ARCHON_FORGE_TOKEN}`);
    process.exit(7);
  }
  if (mode === 'wrong-resolve') {
    process.stdout.write(
      JSON.stringify({
        operationId: input.operationId,
        ok: true,
        result: {
          op: 'resolve',
          value: {
            kind: 'resolved',
            forge: 'test',
            repo: { host: 'other.example', path: 'a/b' },
            plugin: { name: 'test', version: '1.0.0' },
          },
        },
      })
    );
  } else if (mode === 'malformed') process.stdout.write('{');
  else if (mode === 'structured-error') {
    process.stdout.write(
      JSON.stringify({
        operationId: input.operationId,
        ok: false,
        error: { kind: 'forge_error', message: 'réfusé' },
      })
    );
    process.exit(1);
  } else {
    process.stdout.write(
      JSON.stringify({
        operationId: input.operationId,
        ok: true,
        result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
      })
    );
  }
}
