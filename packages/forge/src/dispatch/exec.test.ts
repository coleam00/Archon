import { removeTempTree } from '@archon/paths/test-utils';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPlugin, FORGE_DISPATCH_MAX_BUFFER } from './exec';
const FIXTURES_DIR = join(import.meta.dir, 'fixtures');
const bun = process.execPath;
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}
describe('execPlugin , real subprocess', () => {
  it('passes hostile argv and split UTF-8 bytes verbatim through an explicit .exe interpreter', async () => {
    const text = 'quote " & echo NO | %PATH% 🚀 é';
    const result = await execPlugin(
      {
        command: bun,
        args: [
          '-e',
          'const b=Buffer.from(process.argv[1]); for (const byte of b) { process.stdout.write(Buffer.from([byte])); await Bun.sleep(1); }',
        ],
      },
      [text],
      { env: process.env, stdin: '' }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(text);
  });
  it('refuses Windows cmd and bat paths before any hostile argument reaches a shell', async () => {
    if (process.platform !== 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'forge cmd '));
    try {
      for (const extension of ['cmd', 'bat']) {
        const path = join(dir, `plugin.${extension}`);
        await writeFile(path, '@echo EXECUTED');
        const result = await execPlugin({ command: path, args: [] }, ['a" & echo INJECTED'], {
          env: process.env,
          stdin: '',
        });
        expect(result.spawnError).toBeDefined();
        expect(result.stdout).toBe('');
      }
    } finally {
      await removeTempTree(dir);
    }
  });
  it('cancels one live tree without terminating a concurrent operation', async () => {
    const controller = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), 'forge cancel '));
    const heartbeatFile = join(dir, 'heartbeat');
    try {
      const cancelled = execPlugin(
        { command: bun, args: [join(FIXTURES_DIR, 'hang-plugin.ts')] },
        ['op', 'resolve', heartbeatFile],
        { env: process.env, stdin: '{}', signal: controller.signal }
      );
      const survivor = execPlugin(
        { command: bun, args: ['-e', 'await Bun.sleep(2500); process.stdout.write("alive")'] },
        [],
        { env: process.env, stdin: '' }
      );
      expect(await waitFor(() => Bun.file(heartbeatFile).exists(), 3000)).toBe(true);
      controller.abort();
      const result = await cancelled;
      expect(result.cancelled).toBe(true);
      expect(result.terminationError).toBeUndefined();
      const stopped = await readFile(heartbeatFile, 'utf8');
      expect(await survivor).toMatchObject({ exitCode: 0, stdout: 'alive' });
      await Bun.sleep(300);
      expect(await readFile(heartbeatFile, 'utf8')).toBe(stopped);
    } finally {
      controller.abort();
      await removeTempTree(dir);
    }
  }, 15000);
  it('runs a well-behaved plugin metadata call end to end', async () => {
    const outcome = await execPlugin(
      { command: bun, args: [join(FIXTURES_DIR, 'well-behaved-plugin.ts'), '{}'] },
      ['metadata'],
      { env: { ...process.env }, stdin: '' }
    );
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(outcome.stdout) as { name: string; protocol: number };
    expect(parsed.name).toBe('well-behaved');
    expect(parsed.protocol).toBe(1);
  });
  it('separates a structured op-error (exit 1) from a process failure', async () => {
    const outcome = await execPlugin(
      { command: bun, args: [join(FIXTURES_DIR, 'well-behaved-plugin.ts'), '{}'] },
      ['op', 'not-a-real-op'],
      { env: { ...process.env }, stdin: JSON.stringify({}) }
    );
    expect(outcome.exitCode).toBe(1);
    const parsed = JSON.parse(outcome.stdout) as { kind: string };
    expect(parsed.kind).toBe('unsupported_op');
  });
  it('reports a spawn error for a non-executable path, never throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-exec-'));
    try {
      const notExecutable = join(dir, 'archon-forge-nope');
      await writeFile(notExecutable, '#!/bin/sh\necho hi\n');
      if (process.platform !== 'win32') await chmod(notExecutable, 0o644); // no exec bit
      const outcome = await execPlugin({ command: notExecutable, args: [] }, ['metadata'], {
        env: { ...process.env },
        stdin: '',
      });
      expect(outcome.spawnError).toBeDefined();
    } finally {
      await removeTempTree(dir);
    }
  });
  it('reports a spawn error for a path that does not exist at all', async () => {
    const outcome = await execPlugin(
      { command: join(tmpdir(), `archon-forge-does-not-exist-${String(Date.now())}`), args: [] },
      ['metadata'],
      { env: { ...process.env }, stdin: '' }
    );
    expect(outcome.spawnError).toBeDefined();
  });
  it('flags a buffer overrun and terminates the plugin instead of buffering unbounded output', async () => {
    const outcome = await execPlugin(
      {
        command: bun,
        args: ['-e', 'while (true) { process.stdout.write("x".repeat(1024 * 1024)); }'],
      },
      [],
      { env: { ...process.env }, stdin: '', maxBuffer: 64 * 1024, timeoutMs: 10_000 }
    );
    expect(outcome.bufferExceeded).toBe(true);
  });
  it('defaults to a 16 MiB buffer floor, matching docker-exec.ts', () => {
    expect(FORGE_DISPATCH_MAX_BUFFER).toBe(16 * 1024 * 1024);
  });
  it('terminates the whole process tree on timeout, not just the direct child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-exec-treekill-'));
    const heartbeatFile = join(dir, 'heartbeat');
    try {
      const execPromise = execPlugin(
        { command: bun, args: [join(FIXTURES_DIR, 'hang-plugin.ts')] },
        ['op', 'resolve', heartbeatFile],
        {
          env: process.env,
          stdin: JSON.stringify({}),
          timeoutMs: 1_500,
        }
      );
      // Prove the grandchild is actually alive before the timeout fires.
      const grandchildStarted = await waitFor(async () => {
        try {
          await readFile(heartbeatFile);
          return true;
        } catch {
          return false;
        }
      }, 3_000);
      expect(grandchildStarted).toBe(true);
      const outcome = await execPromise;
      expect(outcome.timedOut).toBe(true);
      // Let any in-flight kill signal actually land, then read the
      // heartbeat's value twice, several multiples of its 100ms write
      // interval apart, and confirm it never advanced in between , the
      // grandchild is really dead, not merely orphaned and still ticking.
      await new Promise(resolve => setTimeout(resolve, 300));
      const valueAtTimeout = await readFile(heartbeatFile, 'utf8');
      await new Promise(resolve => setTimeout(resolve, 800));
      const valueAfterWait = await readFile(heartbeatFile, 'utf8');
      expect(valueAfterWait).toBe(valueAtTimeout);
    } finally {
      await removeTempTree(dir);
    }
  }, 15_000);
});
