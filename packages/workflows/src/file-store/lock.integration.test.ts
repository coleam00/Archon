import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentProcessOwner } from '@archon/paths/process-owner';
import { removeTempTree, skipCompiledBinaryTests, testTimeout } from '@archon/paths/test-utils';
import {
  FileStoreLockHeldError,
  probeFileStoreFilesystem,
  renameReplacing,
  withFileStoreLock,
} from './lock';

type Child = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
const roots: string[] = [];
const children: Child[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const root of roots.splice(0)) await removeTempTree(root);
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'archon-file-lock-')));
  roots.push(root);
  await probeFileStoreFilesystem(root);
  return root;
}

const lockModule = join(import.meta.dir, 'lock.ts');
function spawn(script: string, root: string, logLevel = 'silent'): Child {
  const child = Bun.spawn([process.execPath, '-e', script, root], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LOG_LEVEL: logLevel },
  });
  children.push(child);
  return child;
}

async function succeeds(child: Child): Promise<string> {
  const stdout = (async () => {
    const reader = child.stdout.getReader();
    let result = '';
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) return result;
        result += new TextDecoder().decode(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const stderr = new Response(child.stderr).text();
  expect({ code: await child.exited, stderr: await stderr }).toEqual({ code: 0, stderr: '' });
  return await stdout;
}

async function ready(child: Child): Promise<void> {
  const reader = child.stdout.getReader();
  try {
    const result = await reader.read();
    expect(new TextDecoder().decode(result.value)).toContain('ready');
  } finally {
    reader.releaseLock();
  }
}

describe('file store filesystem primitives', () => {
  test.skipIf(process.env.GITHUB_ACTIONS !== 'true' || skipCompiledBinaryTests())(
    'compiled binary acquires the lock and replaces a document (CI only)',
    async () => {
      const root = await fixture();
      const entry = join(root, 'entry.ts');
      const binary = join(root, process.platform === 'win32' ? 'lock-probe.exe' : 'lock-probe');
      await writeFile(
        entry,
        `
        import { probeFileStoreFilesystem, withFileStoreLock, renameReplacing } from ${JSON.stringify(lockModule)};
        import { readFile, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        const root = process.argv[2];
        await probeFileStoreFilesystem(root);
        await withFileStoreLock(root, async () => {
          await writeFile(join(root, 'new'), 'committed');
          await renameReplacing(join(root, 'new'), join(root, 'document'));
        });
        console.log(await readFile(join(root, 'document'), 'utf8'));
      `
      );
      const build = Bun.spawn(
        [process.execPath, 'build', '--compile', entry, '--outfile', binary],
        {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      children.push(build);
      const output = new Response(build.stdout).text();
      const errors = new Response(build.stderr).text();
      expect({ code: await build.exited, errors: await errors }, await output).toMatchObject({
        code: 0,
      });
      await writeFile(join(root, 'document'), 'before');
      const child = Bun.spawn([binary, root], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, LOG_LEVEL: 'silent' },
      });
      children.push(child);
      expect((await succeeds(child)).trim()).toBe('committed');
    },
    60_000
  );

  test('four processes serialize 500 increments each', async () => {
    const root = await fixture();
    await writeFile(join(root, 'count'), '0');
    const script = `
      import { withFileStoreLock } from ${JSON.stringify(lockModule)};
      import { readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const root = process.argv[1];
      for (let i = 0; i < 500; i++) {
        await withFileStoreLock(root, async () => {
          const path = join(root, 'count');
          const value = Number(await readFile(path, 'utf8'));
          await writeFile(path, String(value + 1));
        }, 60000);
      }
    `;
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () => succeeds(spawn(script, root, 'debug')))
    );
    expect(await readFile(join(root, 'count'), 'utf8')).toBe('2000');
    const retries: Record<string, number> = {};
    for (const line of outputs.join('').split('\n')) {
      if (!line.includes('file_store.windows_handle_retry')) continue;
      const entry = JSON.parse(line) as { operation: string; codes: string[] };
      for (const code of entry.codes) {
        const key = `${entry.operation} ${code}`;
        retries[key] = (retries[key] ?? 0) + 1;
      }
    }
    console.info(`lock handle retries: ${JSON.stringify(retries)}`);
  }, 120_000);

  test('independent in-process callers queue, including after a rejection', async () => {
    const root = await fixture();
    let count = 0;
    await expect(
      withFileStoreLock(root, () => Promise.reject(new Error('failed')))
    ).rejects.toThrow('failed');
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withFileStoreLock(root, async () => {
          const value = count;
          await Bun.sleep(1);
          count = value + 1;
        })
      )
    );
    expect(count).toBe(20);
  });

  test('rename replaces whole files while other processes read', async () => {
    const root = await fixture();
    const target = join(root, 'document');
    const a = 'a'.repeat(8192);
    const b = 'b'.repeat(8192);
    await writeFile(target, a);
    const script = `
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const path = join(process.argv[1], 'document');
      console.log('ready');
      for (let i = 0; i < 1000; i++) {
        const value = await readFile(path, 'utf8');
        if (value !== 'a'.repeat(8192) && value !== 'b'.repeat(8192)) throw Error('partial read');
      }
    `;
    const readers = Array.from({ length: 3 }, () => spawn(script, root));
    await Promise.all(readers.map(ready));
    let retries = 0;
    for (let i = 0; i < 500; i++) {
      const source = join(root, 'replacement');
      await writeFile(source, i % 2 ? a : b);
      retries += await renameReplacing(source, target);
    }
    await Promise.all(readers.map(succeeds));
    console.info(`rename-replace retries: ${String(retries)}`);
  }, 60_000);

  test(
    'SIGKILLed owner is recoverable, and kill(pid, 0) leaves it alive',
    async () => {
      const root = await fixture();
      const child = spawn(
        `
      import { withFileStoreLock } from ${JSON.stringify(lockModule)};
      await withFileStoreLock(process.argv[1], async () => {
        console.log('ready');
        await Bun.sleep(60000);
      });
    `,
        root
      );
      await ready(child);
      process.kill(child.pid, 0);
      expect(child.exitCode).toBeNull();
      await expect(withFileStoreLock(root, async () => {}, 25)).rejects.toBeInstanceOf(
        FileStoreLockHeldError
      );
      child.kill('SIGKILL');
      await child.exited;
      expect(await withFileStoreLock(root, async () => 'recovered')).toBe('recovered');
    },
    testTimeout(10_000)
  );

  test(
    'live parent with a foreign instance is retained',
    async () => {
      const root = await fixture();
      const owner = { ...currentProcessOwner, instance: randomUUID() };
      const contents = JSON.stringify(owner);
      await writeFile(join(root, 'lock'), contents);
      const child = spawn(
        `
      import { FileStoreLockHeldError, withFileStoreLock } from ${JSON.stringify(lockModule)};
      try {
        await withFileStoreLock(process.argv[1], async () => { throw Error('entered'); }, 25);
        process.exit(1);
      } catch (error) {
        if (!(error instanceof FileStoreLockHeldError)) throw error;
        console.log(JSON.stringify({ path: error.path, owner: error.owner }));
      }
    `,
        root
      );
      expect(JSON.parse(await succeeds(child))).toEqual({ path: join(root, 'lock'), owner });
      expect(await readFile(join(root, 'lock'), 'utf8')).toBe(contents);
    },
    testTimeout(10_000)
  );

  test('remote owners and crashed breakers require operator action', async () => {
    const root = await fixture();
    const remote = { ...currentProcessOwner, host: `${currentProcessOwner.host}-remote` };
    await writeFile(join(root, 'lock'), JSON.stringify(remote));
    await expect(withFileStoreLock(root, async () => {}, 25)).rejects.toMatchObject({
      owner: remote,
    });
    const dead = { ...currentProcessOwner, instance: randomUUID() };
    await writeFile(join(root, 'lock'), JSON.stringify(dead));
    await writeFile(join(root, 'lock.break'), JSON.stringify(dead));
    await expect(withFileStoreLock(root, async () => {}, 25)).rejects.toMatchObject({
      path: join(root, 'lock.break'),
      owner: dead,
    });
    expect(JSON.parse(await readFile(join(root, 'lock'), 'utf8'))).toEqual(dead);
  });

  test('a previous instance of this PID is provably gone; malformed records stay intact', async () => {
    const root = await fixture();
    const path = join(root, 'lock');
    await writeFile(path, JSON.stringify({ ...currentProcessOwner, instance: randomUUID() }));
    expect(await withFileStoreLock(root, async () => 'recovered')).toBe('recovered');
    const malformed = JSON.stringify({ ...currentProcessOwner, pid: -1 });
    await writeFile(path, malformed);
    await expect(withFileStoreLock(root, async () => {}, 25)).rejects.toThrow(
      'Invalid owner record'
    );
    expect(await readFile(path, 'utf8')).toBe(malformed);
  });
});
