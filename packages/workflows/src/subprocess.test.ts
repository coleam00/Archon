import { currentNodeProcessRecorder } from './node-process-trees';
import * as git from '@archon/git';
import * as windowsTree from '@archon/paths/windows-process-tree';
import { expect, test, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  isSubprocessTimeout,
  redactSubprocessError,
  recordNodeProcessTrees,
  runSubprocess,
  type RawSubprocessRejection,
} from './subprocess';

const trackTempRoot = trackTempRoots();
const posixOnly = process.platform === 'win32' ? test.skip : test;

function runHostBash(script: string, timeout = 5000): ReturnType<typeof runSubprocess> {
  return runSubprocess({ kind: 'host' }, '/bin/bash', ['-c', script], {
    cwd: import.meta.dir,
    timeout,
    env: {},
    retention: { standalone: true },
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntil(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

test('host-only recording preserves legacy subprocess execution', async () => {
  const trees = recordNodeProcessTrees(false);
  const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'legacy\n', stderr: '' });
  try {
    expect(await runHostBash('echo legacy')).toMatchObject({ stdout: 'legacy\n' });
    expect(execSpy).toHaveBeenCalledTimes(1);
  } finally {
    trees.release();
    execSpy.mockRestore();
  }
});

posixOnly('ending recorded node trees ends the in-flight node and its descendants', async () => {
  const pidFile = join(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-tree-'))), 'pid');
  const trees = recordNodeProcessTrees();
  try {
    const node = runHostBash(`/bin/sleep 30 & echo $! > '${pidFile}'; wait`, 30_000);
    const settled = node.then(
      () => 'resolved',
      () => 'rejected'
    );
    await waitUntil(
      'the descendant pid',
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''
    );
    const descendant = Number(readFileSync(pidFile, 'utf8'));

    await trees.end();

    expect(await settled).toBe('rejected');
    await waitUntil('the descendant to exit', () => !processExists(descendant));
  } finally {
    trees.release();
  }
});

posixOnly('a node whose root exited stays endable while its job holds the output', async () => {
  const pidFile = join(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-tree-'))), 'pid');
  const trees = recordNodeProcessTrees();
  try {
    const node = runHostBash(`/bin/sleep 30 & echo $! > '${pidFile}'`, 30_000);
    const settled = node.then(
      () => 'settled',
      () => 'settled'
    );
    await waitUntil(
      'the descendant pid',
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''
    );
    const descendant = Number(readFileSync(pidFile, 'utf8'));

    await trees.end();

    await waitUntil('the descendant to exit', () => !processExists(descendant));
    expect(await settled).toBe('settled');
  } finally {
    trees.release();
  }
});

for (const runtime of ['bash', 'bun'] as const) {
  posixOnly(
    `owner interruption reports unproved cleanup after a ${runtime} root exits`,
    async () => {
      const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-owner-held-')));
      const ready = join(dir, 'ready');
      const worker = join(dir, 'worker.js');
      writeFileSync(
        worker,
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`
      );
      const trees = recordNodeProcessTrees();
      const rootFile = join(dir, 'root');
      const node = runSubprocess(
        { kind: 'host' },
        runtime === 'bash' ? '/bin/bash' : process.execPath,
        runtime === 'bash'
          ? ['-c', `echo $$ > '${rootFile}'; '${process.execPath}' --no-env-file '${worker}' &`]
          : [
              '--no-env-file',
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(rootFile)}, String(process.pid)); require('node:child_process').spawn(process.execPath, ['--no-env-file', ${JSON.stringify(worker)}], {stdio:'inherit'}); setTimeout(() => process.exit(0), 100);`,
            ],
        {
          cwd: dir,
          timeout: 30000,
          env: {},
          killTreeOnTimeout: true,
          retention: { standalone: true },
        }
      ).catch((error: unknown) => error as RawSubprocessRejection);
      try {
        await waitUntil('descendant readiness', () => existsSync(ready));
        await waitUntil(
          'root exit',
          () => existsSync(rootFile) && !processExists(Number(readFileSync(rootFile, 'utf8')))
        );
        const cleanupMessage = 'still running';
        await expect(trees.end()).rejects.toThrow(cleanupMessage);
        const error = await node;
        expect(error).toMatchObject({
          timedOut: false,
          observedExit: { code: 0, signal: null },
          cleanupError: { message: expect.stringContaining(cleanupMessage) },
        });
        expect(processExists(Number(readFileSync(ready, 'utf8')))).toBe(true);
      } finally {
        trees.release();
        if (existsSync(ready)) {
          const pid = Number(readFileSync(ready, 'utf8'));
          if (processExists(pid)) process.kill(pid, 'SIGKILL');
        }
        await node;
      }
    },
    10000
  );
}

test('Windows owner interruption reports unproved cleanup between root exit and close', async () => {
  const platform = process.platform;
  const child = new childProcess.ChildProcess();
  Object.defineProperties(child, {
    pid: { value: 123456 },
    stdin: { value: null },
    stdout: { value: null },
    stderr: { value: null },
    unref: { value: () => child },
  });
  const spawn = spyOn(childProcess, 'spawn').mockReturnValue(child);
  const taskkill = spyOn(windowsTree, 'terminateWindowsProcessTree').mockRejectedValue(
    new Error('must not target an exited root')
  );
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const trees = recordNodeProcessTrees();
  const node = runNode('unused', 30000).catch((error: unknown) => error as RawSubprocessRejection);
  try {
    // Windows need not inherit the wrapper's pipes. Drive exit before close explicitly.
    child.emit('exit', 0, null);
    const cleanupMessage = 'exited before tree termination could be proved';
    await expect(trees.end()).rejects.toThrow(cleanupMessage);
    expect(await node).toMatchObject({
      timedOut: false,
      observedExit: { code: 0, signal: null },
      cleanupError: { message: expect.stringContaining(cleanupMessage) },
    });
    expect(taskkill).not.toHaveBeenCalled();
  } finally {
    child.emit('close', 0, null);
    await node;
    trees.release();
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    spawn.mockRestore();
    taskkill.mockRestore();
  }
});

function lifelineWatches(pgid: number): boolean {
  const ps = Bun.spawnSync(['/bin/ps', '-A', '-o', 'args=']);
  return ps.stdout
    .toString()
    .split('\n')
    .some(args => args.trim().endsWith(`archon-node-lifeline ${String(pgid)}`));
}

posixOnly('a node that completes disarms its owner-death watcher', async () => {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-tree-')));
  const pidFile = join(dir, 'pid');
  const jobFile = join(dir, 'job');
  const release = join(dir, 'release');
  const trees = recordNodeProcessTrees();
  let job: number | undefined;
  try {
    // The job leaves the node's output, so the node completes while its group lives on.
    const node = runHostBash(
      `/bin/sleep 30 >/dev/null 2>&1 & echo $! > '${jobFile}'; echo $$ > '${pidFile}'; ` +
        `while [ ! -e '${release}' ]; do /bin/sleep 0.05; done`
    );
    await waitUntil(
      'the node pid',
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''
    );
    const root = Number(readFileSync(pidFile, 'utf8'));
    job = Number(readFileSync(jobFile, 'utf8'));
    expect(lifelineWatches(root)).toBe(true);

    writeFileSync(release, '');
    await node;

    await waitUntil('the watcher to exit', () => !lifelineWatches(root));
    expect(processExists(job)).toBe(true);
  } finally {
    trees.release();
    if (job !== undefined && processExists(job)) process.kill(job, 'SIGKILL');
  }
});

posixOnly('no node subprocess starts after the recorded trees are ended', async () => {
  const marker = join(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-tree-'))), 'ran');
  const trees = recordNodeProcessTrees();
  try {
    await trees.end();
    await expect(runHostBash(`touch '${marker}'`)).rejects.toThrow(
      'The run owner is terminating; node subprocess not started'
    );
    expect(existsSync(marker)).toBe(false);
  } finally {
    trees.release();
  }
});

posixOnly('a recorded node deadline still reports the documented SIGTERM', async () => {
  const trees = recordNodeProcessTrees();
  try {
    const error = await runHostBash('exec /bin/sleep 5', 100).then(
      () => undefined,
      (e: unknown) => e as RawSubprocessRejection
    );
    expect(error && isSubprocessTimeout(error)).toBe(true);
    expect(error?.signal).toBe('SIGTERM');
  } finally {
    trees.release();
  }
});

test('an owned-group deadline remains a timeout whatever exit evidence arrives', () => {
  const error = Object.assign(new Error('deadline'), { timedOut: true, code: 7 });
  expect(isSubprocessTimeout(error)).toBe(true);
  expect(isSubprocessTimeout(Object.assign(new Error('exit'), { code: 7 }))).toBe(false);
});

test('owned process groups are rejected before container execution', async () => {
  await expect(
    runSubprocess({ kind: 'container', containerId: 'must-not-execute' }, 'bash', ['-c', 'true'], {
      cwd: '/workspace',
      timeout: 100,
      env: {},
      ownProcessGroup: true,
      retention: { standalone: true },
    })
  ).rejects.toThrow('Owned subprocess groups require host execution');
});

test.skipIf(process.platform === 'win32')(
  'the setup lifeline works when project PATH contains no external utilities',
  async () => {
    const result = await runSubprocess(
      { kind: 'host' },
      '/bin/bash',
      ['-c', '/bin/sleep 0.05; printf completed'],
      {
        cwd: import.meta.dir,
        timeout: 2000,
        env: { PATH: '/nonexistent' },
        ownProcessGroup: true,
        retention: { standalone: true },
      }
    );
    expect(result.stdout).toBe('completed');
    expect(result.stderr).toBe('');
  }
);

for (const recorded of [false, true]) {
  test(`node timeout stops a wrapper's grandchild (recorded=${recorded})`, async () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-tree-')));
    const marker = join(dir, 'marker');
    const ready = join(dir, 'ready');
    const worker = join(dir, 'worker.js');
    writeFileSync(
      worker,
      `import {writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      const parent = process.ppid;
      const watch = setInterval(() => {
        try { process.kill(parent, 0); }
        catch (error) {
          if (error.code !== 'ESRCH') throw error;
          clearInterval(watch);
          setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'leaked'), 1600);
        }
      }, 25);`
    );
    const trees = recorded ? recordNodeProcessTrees() : undefined;
    try {
      const result = runSubprocess(
        { kind: 'host' },
        process.execPath,
        [
          '--no-env-file',
          '-e',
          `require('node:child_process').spawn(process.execPath, ['--no-env-file', ${JSON.stringify(worker)}], {stdio: 'inherit'}); setInterval(() => {}, 1000);`,
        ],
        {
          cwd: dir,
          timeout: 1000,
          env: {},
          retention: { standalone: true },
          ...{ killTreeOnTimeout: true },
        }
      ).catch((error: unknown) => error as RawSubprocessRejection);
      await waitUntil('grandchild readiness', () => existsSync(ready));
      const error = (await result) as RawSubprocessRejection;
      expect(isSubprocessTimeout(error)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1800));
      expect(existsSync(marker)).toBe(false);
    } finally {
      trees?.release();
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, 'utf8'));
        if (processExists(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });
}

function runNode(script: string, timeout = 5000): ReturnType<typeof runSubprocess> {
  return runSubprocess({ kind: 'host' }, process.execPath, ['--no-env-file', '-e', script], {
    cwd: import.meta.dir,
    timeout,
    env: {},
    retention: { standalone: true },
    killTreeOnTimeout: true,
  });
}

test('ending recorded node bodies stops a live wrapper and its grandchild', async () => {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-owner-live-')));
  const marker = join(dir, 'marker');
  const ready = join(dir, 'ready');
  const root = join(dir, 'root');
  const worker = join(dir, 'worker.js');
  writeFileSync(
    worker,
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); const parent = process.ppid;
        const watch = setInterval(() => {
          try { process.kill(parent, 0); }
          catch (error) {
            if (error.code !== 'ESRCH') throw error;
            clearInterval(watch);
            setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 1600);
          }
        }, 25);`
  );
  const trees = recordNodeProcessTrees();
  const node = runNode(
    `require('node:fs').writeFileSync(${JSON.stringify(root)}, String(process.pid)); require('node:child_process').spawn(process.execPath, ['--no-env-file', ${JSON.stringify(worker)}], {stdio: 'inherit'}); setInterval(() => {}, 1000);`,
    30000
  ).catch((error: unknown) => error as RawSubprocessRejection);
  try {
    await waitUntil('grandchild readiness', () => existsSync(ready));
    expect(processExists(Number(readFileSync(root, 'utf8')))).toBe(true);
    await trees.end();
    expect(await node).toMatchObject({ timedOut: false, cleanupError: undefined });
    await Bun.sleep(1800);
    expect(existsSync(marker)).toBe(false);
    expect(processExists(Number(readFileSync(ready, 'utf8')))).toBe(false);
  } finally {
    trees.release();
    for (const file of [ready, root]) {
      if (existsSync(file)) {
        const pid = Number(readFileSync(file, 'utf8'));
        if (processExists(pid)) process.kill(pid, 'SIGKILL');
      }
    }
    await node;
  }
});

posixOnly(
  'node timeout escalates only while its leader remains alive',
  async () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-escalate-')));
    const ready = join(dir, 'ready');
    const node = runNode(
      `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000);`,
      1000
    ).catch((e: unknown) => e as RawSubprocessRejection);
    await waitUntil('TERM handler', () => existsSync(ready));
    const start = Date.now();
    const error = (await node) as RawSubprocessRejection;
    expect(error.cleanupError).toBeUndefined();
    expect(error).toMatchObject({
      killed: true,
      timedOut: true,
      code: null,
      signal: 'SIGTERM',
      observedExit: { code: null, signal: 'SIGKILL' },
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(5000);
  },
  10000
);

posixOnly(
  'an exited leader with a surviving descendant fails cleanup without a late group kill',
  async () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-orphan-')));
    const ready = join(dir, 'ready');
    const worker = join(dir, 'worker.js');
    writeFileSync(
      worker,
      `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`
    );
    const node = runNode(
      `require('node:child_process').spawn(process.execPath, ['--no-env-file', ${JSON.stringify(worker)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`,
      1000
    ).catch((e: unknown) => e as RawSubprocessRejection);
    try {
      await waitUntil('TERM-ignoring descendant', () => existsSync(ready));
      const error = (await node) as RawSubprocessRejection;
      expect(error.cleanupError?.message).toContain('still running');
      expect(error.observedExit?.signal).toBe('SIGTERM');
      const pid = Number(readFileSync(ready, 'utf8'));
      expect(processExists(pid)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(processExists(pid)).toBe(true);
    } finally {
      if (existsSync(ready)) process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
    }
  },
  10000
);

posixOnly(
  'an already-exited root holding output cannot be cleaned up by a stale group signal',
  async () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-held-')));
    const ready = join(dir, 'ready');
    const node = runSubprocess(
      { kind: 'host' },
      '/bin/bash',
      ['-c', `/bin/sleep 30 & echo $! > '${ready}'`],
      {
        cwd: dir,
        env: {},
        timeout: 500,
        killTreeOnTimeout: true,
        retention: { standalone: true },
      }
    ).catch((e: unknown) => e as RawSubprocessRejection);
    try {
      await waitUntil('background child', () => existsSync(ready));
      const error = (await node) as RawSubprocessRejection;
      expect(error.observedExit?.code).toBe(0);
      expect(error.cleanupError?.message).toContain('still running');
      expect(processExists(Number(readFileSync(ready, 'utf8')))).toBe(true);
    } finally {
      if (existsSync(ready)) process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
    }
  },
  10000
);

for (const recorded of [false, true]) {
  posixOnly(
    `node bodies do not arm a watcher with a stored group id (recorded=${recorded})`,
    async () => {
      const trees = recorded ? recordNodeProcessTrees() : undefined;
      const spawn = spyOn(childProcess, 'spawn');
      try {
        await runNode(`console.log('completed')`);
        expect(spawn.mock.calls.map(([cmd]) => cmd)).toEqual([process.execPath]);
      } finally {
        spawn.mockRestore();
        trees?.release();
      }
    }
  );
}

posixOnly('node timeout lets a two-second SIGTERM handler finish cleanup', async () => {
  const result = await runNode(
    `process.on('SIGTERM', () => setTimeout(() => { console.log('cleanup finished'); process.exit(0) }, 2000)); setInterval(() => {}, 1000);`,
    1000
  ).catch((error: unknown) => error as RawSubprocessRejection);
  expect(result).toMatchObject({
    timedOut: true,
    cleanupError: undefined,
    stdout: 'cleanup finished\n',
    observedExit: { code: 0, signal: null },
  });
});

test('node bodies preserve output, numeric exit, spawn errno, and the stream bound', async () => {
  expect(await runNode(`process.stdout.write('out'); process.stderr.write('err')`)).toMatchObject({
    stdout: 'out',
    stderr: 'err',
  });
  const exit = await runNode(`process.stdout.write('out'); process.exit(7)`).catch(
    (e: unknown) => e as RawSubprocessRejection
  );
  expect(exit).toMatchObject({ code: 7, stdout: 'out', timedOut: false });
  await expect(
    runSubprocess({ kind: 'host' }, '/nonexistent/archon-test-executable', [], {
      cwd: import.meta.dir,
      timeout: 1000,
      env: {},
      killTreeOnTimeout: true,
      retention: { standalone: true },
    })
  ).rejects.toMatchObject({ code: 'ENOENT' });
  const overflow = await runNode(
    `process.stdout.write('x'.repeat(2*1024*1024)); setInterval(() => {}, 1000)`
  ).catch((e: unknown) => e as RawSubprocessRejection);
  expect(overflow).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  expect((overflow as RawSubprocessRejection).stdout?.length).toBe(1024 * 1024);
});

posixOnly(
  'a denied group signal settles with its termination error even while output stays open',
  async () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-denied-')));
    const ready = join(dir, 'ready');
    const kill = process.kill.bind(process);
    const error = Object.assign(new Error('group signal denied'), { code: 'EPERM' });
    const killSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal !== 0) throw error;
      return kill(pid, signal);
    });
    const started = Date.now();
    const node = runNode(
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
      500
    ).catch((e: unknown) => e as RawSubprocessRejection);
    try {
      await waitUntil('root readiness', () => existsSync(ready));
      const rejection = (await node) as RawSubprocessRejection;
      expect(rejection.cleanupError).toBe(error);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      killSpy.mockRestore();
      if (existsSync(ready)) kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
    }
  }
);

posixOnly(
  'group confirmation preserves a probe permission error',
  async () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-probe-')));
    const ready = join(dir, 'ready');
    const kill = process.kill.bind(process);
    const denied = Object.assign(new Error('group probe denied'), { code: 'EPERM' });
    const killSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0) throw denied;
      return kill(pid, signal);
    });
    try {
      const rejection = await runNode(
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
        500
      ).catch((e: unknown) => e as RawSubprocessRejection);
      expect((rejection as RawSubprocessRejection).cleanupError).toBe(denied);
    } finally {
      killSpy.mockRestore();
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, 'utf8'));
        if (processExists(pid)) kill(pid, 'SIGKILL');
      }
    }
  },
  10000
);

for (const fails of [false, true]) {
  test(`Windows timeout requires successful tree termination (taskkill fails=${fails})`, async () => {
    const platform = process.platform;
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-windows-')));
    const ready = join(dir, 'ready');
    const taskkillError = Object.assign(new Error('taskkill could not prove cleanup'), {
      code: 'ENOENT',
    });
    const taskkill = spyOn(windowsTree, 'terminateWindowsProcessTree').mockImplementation(
      async pid => {
        process.kill(pid, 'SIGKILL');
        await Bun.sleep(50);
        if (fails) throw taskkillError;
      }
    );
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const rejection = (await runNode(
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
        500
      ).catch((e: unknown) => e as RawSubprocessRejection)) as RawSubprocessRejection;
      expect(taskkill).toHaveBeenCalledTimes(1);
      expect(rejection).toMatchObject({
        code: null,
        signal: 'SIGTERM',
        killed: true,
        timedOut: true,
      });
      expect(rejection.observedExit).toBeDefined();
      expect(rejection.cleanupError).toBe(fails ? taskkillError : undefined);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      taskkill.mockRestore();
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, 'utf8'));
        if (processExists(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });
}

posixOnly('a node body leaves stdin open without ending a successful background job', async () => {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-background-')));
  const ready = join(dir, 'ready');
  const release = join(dir, 'release');
  const node = runSubprocess(
    { kind: 'host' },
    '/bin/bash',
    [
      '-c',
      `/bin/sleep 30 >/dev/null 2>&1 & echo "$$ $!" > '${ready}'; while [ ! -e '${release}' ]; do /bin/sleep 0.05; done`,
    ],
    {
      cwd: dir,
      env: {},
      timeout: 5000,
      killTreeOnTimeout: true,
      retention: { standalone: true },
    }
  );
  try {
    await waitUntil(
      'background job',
      () => existsSync(ready) && readFileSync(ready, 'utf8').trim().split(' ').length === 2
    );
    const [root, job] = readFileSync(ready, 'utf8').trim().split(' ').map(Number);
    expect(lifelineWatches(root)).toBe(false);
    writeFileSync(release, '');
    await node;
    expect(processExists(job)).toBe(true);
    const stdin = await runNode(
      `let eof = false; process.stdin.on('end', () => {eof=true}); process.stdin.resume(); setTimeout(() => { console.log(eof); process.exit(0) }, 50)`
    );
    expect(stdin.stdout.trim()).toBe('false');
  } finally {
    if (existsSync(ready)) {
      const job = Number(readFileSync(ready, 'utf8').trim().split(' ')[1]);
      if (processExists(job)) process.kill(job, 'SIGKILL');
    }
  }
});

posixOnly('deadline and owner stop share one tree operation and clear later timers', async () => {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-race-')));
  const ready = join(dir, 'ready');
  const trees = recordNodeProcessTrees();
  const kill = process.kill.bind(process);
  const signals: number[] = [];
  const killSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 'SIGTERM') signals.push(pid);
    return kill(pid, signal);
  });
  try {
    const node = runNode(
      `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
      500
    ).catch((e: unknown) => e as RawSubprocessRejection);
    await waitUntil('node readiness', () => existsSync(ready));
    await waitUntil('deadline termination', () => signals.length > 0);
    await trees.end();
    const error = (await node) as RawSubprocessRejection;
    expect(error.cleanupError).toBeUndefined();
    expect(error.timedOut).toBe(true);
    expect(signals).toHaveLength(1);
    await Bun.sleep(100);
    expect(signals).toHaveLength(1);
    await expect(runNode(`console.log('must not start')`)).rejects.toThrow('owner is terminating');
  } finally {
    killSpy.mockRestore();
    trees.release();
    if (existsSync(ready)) {
      const pid = Number(readFileSync(ready, 'utf8'));
      if (processExists(pid)) kill(pid, 'SIGKILL');
    }
  }
});

test('cleanup error redaction covers nested termination evidence', () => {
  const secret = 'termination-error-secret';
  const cleanupError = Object.assign(new Error(`denied ${secret}`), {
    cmd: `taskkill ${secret}`,
    spawnargs: [secret],
    stdout: secret,
    stderr: secret,
  });
  const rejection = Object.assign(new Error(`failed ${secret}`), { cleanupError });
  redactSubprocessError(rejection, [secret]);
  for (const value of [
    cleanupError.message,
    cleanupError.stack,
    cleanupError.cmd,
    ...cleanupError.spawnargs,
    cleanupError.stdout,
    cleanupError.stderr,
  ]) {
    expect(value).not.toContain(secret);
    expect(value).toContain('[REDACTED]');
  }
});

test('Windows taskkill success without an observed root exit is a bounded cleanup failure', async () => {
  const platform = process.platform;
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-timeout-unconfirmed-')));
  const ready = join(dir, 'ready');
  const taskkill = spyOn(windowsTree, 'terminateWindowsProcessTree').mockResolvedValue(undefined);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const started = Date.now();
    const error = (await runNode(
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
      500
    ).catch((e: unknown) => e as RawSubprocessRejection)) as RawSubprocessRejection;
    expect(error.cleanupError?.message).toContain('did not exit after taskkill');
    expect(Date.now() - started).toBeLessThan(2500);
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    taskkill.mockRestore();
    if (existsSync(ready)) process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
  }
});

for (const denied of [false, true]) {
  test(`Windows timeout confirms descendants spawned during taskkill (kill denied=${denied})`, async () => {
    const platform = process.platform;
    const child = new childProcess.ChildProcess();
    const root = 123456;
    const descendant = root + 1;
    Object.defineProperties(child, {
      pid: { value: root },
      stdin: { value: null },
      stdout: { value: null },
      stderr: { value: null },
      unref: { value: () => child },
    });
    let rootAlive = true;
    let descendantAlive = false;
    let listings = 0;
    const spawn = spyOn(childProcess, 'spawn').mockReturnValue(child);
    const execFile = spyOn(windowsTree.windowsProcessCommands, 'execFile').mockImplementation(
      async command => {
        if (command === 'taskkill') {
          rootAlive = false;
          descendantAlive = true;
          child.emit('exit', 1, null);
          return { stdout: 'SUCCESS', stderr: '' };
        }
        listings++;
        return {
          stdout: JSON.stringify({
            takenAt: String(listings * 100),
            rows: [
              ...(rootAlive ? [{ pid: root, parentPid: 1, created: '10' }] : []),
              ...(descendantAlive ? [{ pid: descendant, parentPid: root, created: '150' }] : []),
            ],
          }),
          stderr: '',
        };
      }
    );
    const kill = spyOn(process, 'kill').mockImplementation(pid => {
      expect(pid).toBe(descendant);
      if (denied) throw Object.assign(new Error('descendant kill denied'), { code: 'EPERM' });
      descendantAlive = false;
      return true;
    });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const error = await runNode('unused', 1).catch((e: unknown) => e as RawSubprocessRejection);
      expect(error).toMatchObject({ timedOut: true, observedExit: { code: 1, signal: null } });
      expect(kill).toHaveBeenCalled();
      expect(descendantAlive).toBe(denied);
      if (denied) {
        expect((error as RawSubprocessRejection).cleanupError?.message).toContain('still running');
        expect((error as RawSubprocessRejection).cleanupError?.message).toContain(
          'descendant kill denied'
        );
      } else {
        expect((error as RawSubprocessRejection).cleanupError).toBeUndefined();
        expect(listings).toBe(3);
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      spawn.mockRestore();
      execFile.mockRestore();
      kill.mockRestore();
    }
  });
}

for (const trigger of ['timeout', 'recorder', 'buffer'] as const) {
  test.each([false, true])(
    `Windows ${trigger} refuses cleanup with an unseen intermediate parent (initial=%s)`,
    async initial => {
      const platform = process.platform;
      const child = new childProcess.ChildProcess();
      const root = 123456;
      const stdout = new PassThrough();
      Object.defineProperties(child, {
        pid: { value: root },
        stdin: { value: null },
        stdout: { value: stdout },
        stderr: { value: null },
        unref: { value: () => child },
      });
      let killed = false;
      const spawn = spyOn(childProcess, 'spawn').mockReturnValue(child);
      const commands = spyOn(windowsTree.windowsProcessCommands, 'execFile').mockImplementation(
        async command => {
          if (command === 'taskkill') {
            killed = true;
            child.emit('exit', 1, null);
            throw new Error('taskkill denied');
          }
          return {
            stdout: JSON.stringify({
              takenAt: killed ? '200' : '100',
              rows: killed
                ? [{ pid: root + 2, parentPid: root + 1, created: '150' }]
                : [
                    { pid: root, parentPid: 1, created: '10' },
                    ...(initial ? [{ pid: root + 2, parentPid: root + 1, created: '50' }] : []),
                  ],
            }),
            stderr: '',
          };
        }
      );
      const kill = spyOn(process, 'kill').mockReturnValue(true);
      const trees = trigger === 'recorder' ? recordNodeProcessTrees(false) : undefined;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const outcome = runNode('unused', trigger === 'timeout' ? 1 : 60000).catch(
          (error: unknown) => error as RawSubprocessRejection
        );
        if (trigger === 'recorder') {
          await expect(trees?.end()).rejects.toThrow('unproved ancestry');
        } else if (trigger === 'buffer') {
          stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
        }
        const error = (await outcome) as RawSubprocessRejection;
        expect(error.cleanupError?.message).toContain('taskkill denied');
        expect(error.cleanupError?.message).toContain('unproved ancestry');
        expect(killed).toBe(true);
        expect(kill).not.toHaveBeenCalled();
        if (trigger === 'timeout') expect(error.timedOut).toBe(true);
        if (trigger === 'buffer') expect(error.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      } finally {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        trees?.release();
        spawn.mockRestore();
        commands.mockRestore();
        kill.mockRestore();
      }
    }
  );
}

test('recorded cleanup failures retain each root as aggregate evidence', async () => {
  const trees = recordNodeProcessTrees(false);
  const recorder = currentNodeProcessRecorder();
  if (!recorder) throw new Error('Expected recorder');
  try {
    for (const pid of [10, 20, 30]) {
      recorder.roots.set(pid, {
        end: async () => {
          throw new Error(`taskkill denied; ancestry ${pid}`);
        },
        disarm: () => {},
      });
    }
    const error = await trees.end().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Expected aggregate evidence');
    expect(error.errors.map((failure: Error) => failure.message)).toEqual(
      [10, 20, 30].map(pid => `${pid} (taskkill denied; ancestry ${pid})`)
    );
  } finally {
    trees.release();
  }
});
