import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentProcessOwner } from '@archon/paths/process-owner';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import {
  FileStoreLockHeldError,
  FileStoreLockRecordError,
  FileStoreLockReleaseError,
  FileStoreUnsupportedFilesystemError,
  probeFileStoreFilesystem,
  renameReplacing,
  withFileStoreLock,
} from './lock';

type Child = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
const roots: string[] = [];
const children: Child[] = [];
const spies: { mockRestore(): void }[] = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
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

/** A pid on this host that no process holds, so an owner record naming it is provably gone. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, '-e', ''], { stdin: 'ignore' });
  await child.exited;
  return child.pid;
}

function injected(): Error {
  return Object.assign(new Error('injected failure'), { code: 'EIO' });
}

/** Fails `unlink` for matching paths, at most `times` times, until the spy is restored. */
function failUnlink(matches: (path: string) => boolean, times = Infinity): { mockRestore(): void } {
  const real = fsPromises.unlink;
  let failures = 0;
  const spy = spyOn(fsPromises, 'unlink').mockImplementation(path => {
    if (failures >= times || !matches(String(path))) return real(path);
    failures++;
    return Promise.reject(injected());
  });
  spies.push(spy);
  return spy;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
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
  // Compiling is CI-only on every OS (local compiles have stalled macOS syspolicyd). On CI it
  // never skips, so the macOS job cannot pass without the compiled proof.
  test.skipIf(process.env.GITHUB_ACTIONS !== 'true')(
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
    // A schedule where the children happened to run one after another proves nothing.
    expect(outputs.join('')).toContain('file_store.lock_wait');
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

  // Without the in-process queue, a caller would find this process's own record in
  // `lock`, reclaim it as a leftover, and run beside the holder.
  test('in-process callers queue rather than contend for the file lock, including after a rejection', async () => {
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
      import { existsSync } from 'node:fs';
      const path = join(process.argv[1], 'document');
      const done = join(process.argv[1], 'done');
      const seen = { a: false, b: false, reads: 0 };
      console.log('ready');
      while (!existsSync(done)) {
        const value = await readFile(path, 'utf8');
        if (value === 'a'.repeat(8192)) seen.a = true;
        else if (value === 'b'.repeat(8192)) seen.b = true;
        else throw Error('partial read');
        seen.reads++;
      }
      console.log(JSON.stringify(seen));
    `;
    const readers = Array.from({ length: 3 }, () => spawn(script, root));
    await Promise.all(readers.map(ready));
    let retries = 0;
    for (let i = 0; i < 500; i++) {
      const source = join(root, 'replacement');
      await writeFile(source, i % 2 ? a : b);
      retries += await renameReplacing(source, target);
    }
    await writeFile(join(root, 'done'), '');
    const seen = await Promise.all(readers.map(async reader => JSON.parse(await succeeds(reader))));
    // Every reader overlapped the replacements: it read both versions, never a partial one.
    for (const reader of seen) expect(reader).toMatchObject({ a: true, b: true });
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
    await writeFile(path, '{');
    let entered = false;
    const error = await rejection(
      withFileStoreLock(root, async () => {
        entered = true;
      })
    );
    expect(error).toBeInstanceOf(FileStoreLockRecordError);
    expect((error as FileStoreLockRecordError).path).toBe(path);
    expect(entered).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('{');
  });

  test.skipIf(process.platform === 'win32')(
    'a lock name that never reads as an owner still times out',
    async () => {
      const root = await fixture();
      // A dangling symlink exists for link (EEXIST) but reads as ENOENT every time.
      await symlink(join(root, 'missing'), join(root, 'lock'));
      const error = await rejection(withFileStoreLock(root, async () => {}, 50));
      expect(error).toBeInstanceOf(FileStoreLockHeldError);
      expect((error as FileStoreLockHeldError).owner).toBeNull();
    }
  );

  test('waiters racing to break one dead lock never hold it together', async () => {
    const dead = await deadPid();
    const script = `
        import { withFileStoreLock } from ${JSON.stringify(lockModule)};
        import { existsSync } from 'node:fs';
        import { open, readFile, unlink, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        const root = process.argv[1];
        console.log('ready');
        while (!existsSync(join(root, 'go'))) await Bun.sleep(1);
        for (let i = 0; i < 5; i++) {
          await withFileStoreLock(root, async () => {
            // 'wx' fails if another holder is inside the critical section.
            await (await open(join(root, 'holder'), 'wx')).close();
            const value = Number(await readFile(join(root, 'count'), 'utf8'));
            await Bun.sleep(5);
            await writeFile(join(root, 'count'), String(value + 1));
            await unlink(join(root, 'holder'));
          }, 60000);
        }
      `;
    for (let round = 0; round < 5; round++) {
      const root = await fixture();
      await writeFile(join(root, 'count'), '0');
      await writeFile(
        join(root, 'lock'),
        JSON.stringify({ ...currentProcessOwner, pid: dead, instance: randomUUID() })
      );
      const racers = Array.from({ length: 8 }, () => spawn(script, root));
      await Promise.all(racers.map(ready));
      await writeFile(join(root, 'go'), '');
      await Promise.all(racers.map(succeeds));
      expect(await readFile(join(root, 'count'), 'utf8')).toBe('40');
    }
  }, 120_000);

  test('a breaker never removes a lock that changed hands after its first read', async () => {
    const root = await fixture();
    const path = join(root, 'lock');
    const live = spawn('await Bun.sleep(60000)', root);
    const successor = { ...currentProcessOwner, pid: live.pid, instance: randomUUID() };
    await writeFile(
      path,
      JSON.stringify({ ...currentProcessOwner, pid: await deadPid(), instance: randomUUID() })
    );
    // Between reading the dead owner and taking lock.break, another waiter breaks the
    // dead lock and acquires it, so this breaker's first read is stale.
    const real = fsPromises.link;
    const spy = spyOn(fsPromises, 'link').mockImplementation(async (source, target) => {
      if (String(target) === join(root, 'lock.break')) {
        await writeFile(path, JSON.stringify(successor));
      }
      return real(source, target);
    });
    spies.push(spy);
    let entered = false;
    const error = await rejection(
      withFileStoreLock(
        root,
        async () => {
          entered = true;
        },
        50
      )
    );
    expect(error).toBeInstanceOf(FileStoreLockHeldError);
    expect(entered).toBe(false);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(successor);
  });

  test('a live breaker blocks a second breaker of a dead lock', async () => {
    const root = await fixture();
    const live = spawn('await Bun.sleep(60000)', root);
    const dead = JSON.stringify({
      ...currentProcessOwner,
      pid: await deadPid(),
      instance: randomUUID(),
    });
    const breaker = { ...currentProcessOwner, pid: live.pid, instance: randomUUID() };
    await writeFile(join(root, 'lock'), dead);
    await writeFile(join(root, 'lock.break'), JSON.stringify(breaker));
    const error = await rejection(withFileStoreLock(root, async () => {}, 50));
    expect(error).toBeInstanceOf(FileStoreLockHeldError);
    expect({ ...(error as FileStoreLockHeldError) }).toMatchObject({
      path: join(root, 'lock.break'),
      owner: breaker,
    });
    expect(await readFile(join(root, 'lock'), 'utf8')).toBe(dead);
    expect(JSON.parse(await readFile(join(root, 'lock.break'), 'utf8'))).toEqual(breaker);
  });

  test('a failed release is reported, and the next call reclaims the lock', async () => {
    const root = await fixture();
    const path = join(root, 'lock');
    failUnlink(candidate => candidate === path, 1);
    const error = await rejection(withFileStoreLock(root, async () => 'committed'));
    expect(error).toBeInstanceOf(FileStoreLockReleaseError);
    expect((error as FileStoreLockReleaseError).result).toBe('committed');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(currentProcessOwner);
    expect(await withFileStoreLock(root, async () => 'reclaimed', 100)).toBe('reclaimed');
    expect(await readdir(root)).not.toContain('lock');
  });

  // Another copy of this module in the process would write the same owner record, so
  // only a lock this module itself failed to remove may be reclaimed.
  test('a lock naming this process that this module never stranded is waited on', async () => {
    const root = await fixture();
    const path = join(root, 'lock');
    const record = JSON.stringify(currentProcessOwner);
    await writeFile(path, record);
    let entered = false;
    const error = await rejection(
      withFileStoreLock(
        root,
        async () => {
          entered = true;
        },
        50
      )
    );
    expect(error).toBeInstanceOf(FileStoreLockHeldError);
    expect(entered).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(record);
  });

  test('a failed release never replaces the operation error', async () => {
    const root = await fixture();
    failUnlink(candidate => candidate === join(root, 'lock'), 1);
    await expect(
      withFileStoreLock(root, () => Promise.reject(new Error('operation failed')))
    ).rejects.toThrow('operation failed');
  });

  test('failed scratch-file cleanup never strands the lock or the result', async () => {
    const root = await fixture();
    const scratch = failUnlink(path => /[\\/](\.lock-|lock\.break$)/.test(path));
    expect(await withFileStoreLock(root, async () => 'done', 100)).toBe('done');
    await writeFile(
      join(root, 'lock'),
      JSON.stringify({ ...currentProcessOwner, pid: await deadPid(), instance: randomUUID() })
    );
    expect(await withFileStoreLock(root, async () => 'broken', 100)).toBe('broken');
    expect(JSON.parse(await readFile(join(root, 'lock.break'), 'utf8'))).toEqual(
      currentProcessOwner
    );
    scratch.mockRestore();
    // This process's own leftover breaker is reclaimed the next time a dead lock needs it.
    await writeFile(
      join(root, 'lock'),
      JSON.stringify({ ...currentProcessOwner, pid: await deadPid(), instance: randomUUID() })
    );
    expect(await withFileStoreLock(root, async () => 'again', 100)).toBe('again');
    const left = await readdir(root);
    expect(left).not.toContain('lock');
    expect(left).not.toContain('lock.break');
  });

  test('the probe refuses only link failures that mean no hard-link support', async () => {
    const root = await fixture();
    const real = fsPromises.link;
    const unsupported = spyOn(fsPromises, 'link').mockImplementation(() =>
      Promise.reject(Object.assign(new Error('not supported'), { code: 'ENOTSUP' }))
    );
    spies.push(unsupported);
    await expect(probeFileStoreFilesystem(root)).rejects.toBeInstanceOf(
      FileStoreUnsupportedFilesystemError
    );
    // On Windows, EPERM that outlasts the handle retries is reported as itself.
    unsupported.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' }))
    );
    const denied = await rejection(probeFileStoreFilesystem(root));
    if (process.platform === 'win32') {
      expect(denied).not.toBeInstanceOf(FileStoreUnsupportedFilesystemError);
      expect(denied).toMatchObject({ code: 'EPERM' });
    } else {
      expect(denied).toBeInstanceOf(FileStoreUnsupportedFilesystemError);
    }
    unsupported.mockImplementation(() => Promise.reject(injected()));
    const error = await rejection(probeFileStoreFilesystem(root));
    expect(error).not.toBeInstanceOf(FileStoreUnsupportedFilesystemError);
    expect(error).toMatchObject({ code: 'EIO' });
    unsupported.mockImplementation(real);
    await probeFileStoreFilesystem(root);
    expect((await readdir(root)).filter(name => name.startsWith('.probe-'))).toEqual([]);
  });
});
