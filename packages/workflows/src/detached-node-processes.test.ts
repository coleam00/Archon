// @archon-test-isolated
import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as processTools from '@archon/paths/plugin-process';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  isSubprocessTimeout,
  recordNodeProcessTrees,
  runSubprocess,
  type RawSubprocessRejection,
} from './subprocess';

const trackTempRoot = trackTempRoots();
const posixOnly = process.platform === 'win32' ? test.skip : test;

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Fixture did not reach the expected state');
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

function killFixture(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid fixture PID');
  if (alive(pid)) process.kill(pid, 'SIGKILL');
}

function fixtureDir(): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-detached-node-')));
}

function body(cmd: string, args: string[], timeout?: number): ReturnType<typeof runSubprocess> {
  return runSubprocess({ kind: 'host' }, cmd, args, {
    cwd: import.meta.dir,
    endTreeOnTimeout: true,
    retention: { standalone: true },
    env: {},
    timeout,
  });
}

async function failure(node: ReturnType<typeof runSubprocess>): Promise<RawSubprocessRejection> {
  try {
    await node;
  } catch (error) {
    return error as RawSubprocessRejection;
  }
  throw new Error('Expected command to fail');
}

posixOnly(
  'a detached node timeout confirms wrapper, child and grandchild absence',
  async () => {
    const dir = fixtureDir();
    const ready = join(dir, 'ready');
    const marker = join(dir, 'marker');
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 2200)`;
    const child = `const c = Bun.spawn([process.execPath, '-e', ${JSON.stringify(grandchild)}], {stdio: ['ignore', 'inherit', 'inherit']}); require('fs').writeFileSync(${JSON.stringify(join(dir, 'child'))}, String(process.pid)); await c.exited;`;
    const wrapper = `const c = Bun.spawn([process.execPath, '-e', ${JSON.stringify(child)}], {stdio: ['ignore', 'inherit', 'inherit']}); require('fs').writeFileSync(${JSON.stringify(join(dir, 'root'))}, String(process.pid)); await c.exited;`;
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    try {
      const error = await failure(body(process.execPath, ['-e', wrapper], 1200));
      expect(error).toMatchObject({ timedOut: true, code: null, signal: 'SIGTERM' });
      expect(isSubprocessTimeout(error)).toBe(true);
      expect(existsSync(ready)).toBe(true);
      for (const file of ['root', 'child', 'ready'])
        expect(alive(Number(readFileSync(join(dir, file), 'utf8')))).toBe(false);
      await Bun.sleep(2300);
      expect(existsSync(marker)).toBe(false);
    } finally {
      trees.release();
      for (const file of ['root', 'child', 'ready']) {
        if (existsSync(join(dir, file))) killFixture(Number(readFileSync(join(dir, file), 'utf8')));
      }
    }
  },
  10000
);

posixOnly('direct execution preserves numeric exit 143 versus SIGTERM', async () => {
  const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
  try {
    expect(await failure(body('/bin/bash', ['-c', 'exit 143']))).toMatchObject({
      code: 143,
      signal: null,
      timedOut: false,
    });
    expect(await failure(body('/bin/bash', ['-c', 'kill -TERM $$']))).toMatchObject({
      code: null,
      signal: 'SIGTERM',
      timedOut: false,
    });
  } finally {
    trees.release();
  }
});

posixOnly(
  'completed commands preserve success and report uncertainty across preparations',
  async () => {
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    try {
      const fresh = trees.prepareTermination();
      expect(await fresh.ready).toEqual([]);
      fresh.release();
      expect(await body('/bin/echo', ['ordinary success'])).toMatchObject({
        stdout: 'ordinary success\n',
        stderr: '',
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const prepared = trees.prepareTermination();
        expect(prepared.groups).toEqual([]);
        expect(await prepared.ready).toEqual([
          expect.stringContaining('may have left untracked background work'),
        ]);
        prepared.release();
      }
    } finally {
      trees.prepareTermination().release();
      trees.release();
    }
    const fresh = recordNodeProcessTrees({ mode: 'detached-posix' });
    try {
      expect(await fresh.prepareTermination().ready).toEqual([]);
    } finally {
      fresh.prepareTermination().release();
      fresh.release();
    }
  }
);

posixOnly(
  'termination preparation signals live groups once and holds results until release',
  async () => {
    const dir = fixtureDir();
    const ready = join(dir, 'root');
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    let settled = false;
    const node = failure(
      body('/bin/bash', ['-c', `echo $$ > '${ready}'; exec /bin/sleep 30`])
    ).then(error => {
      settled = true;
      return error;
    });
    try {
      await waitUntil(() => existsSync(ready) && readFileSync(ready, 'utf8').trim() !== '');
      const pgid = Number(readFileSync(ready, 'utf8'));
      const signals = spyOn(process, 'kill');
      const prepared = trees.prepareTermination();
      expect(trees.prepareTermination()).toBe(prepared);
      expect(prepared.groups).toEqual([{ pgid, leaderReaped: false }]);
      expect(signals.mock.calls.filter(([pid]) => pid === -pgid)).toEqual([[-pgid, 'SIGKILL']]);
      signals.mockRestore();
      await waitUntil(() => !alive(pgid));
      expect(settled).toBe(false);
      expect(await prepared.ready).toEqual([
        expect.stringContaining('may have left untracked background work'),
      ]);
      for (const options of [{ endTreeOnTimeout: true }, {}, { ownProcessGroup: true }] as const) {
        await expect(
          runSubprocess({ kind: 'host' }, '/bin/echo', ['blocked'], {
            cwd: dir,
            env: {},
            ...options,
            retention: { standalone: true },
          })
        ).rejects.toThrow('The run owner is terminating');
      }
      prepared.release();
      prepared.release();
      expect(await node).toMatchObject({ code: null, signal: 'SIGKILL' });
      expect((await body('/bin/echo', ['resumed'])).stdout).toBe('resumed\n');
    } finally {
      trees.prepareTermination().release();
      trees.release();
      if (existsSync(ready)) killFixture(Number(readFileSync(ready, 'utf8')));
      await node;
    }
  }
);

posixOnly(
  'releasing a controller hold never reopens an owner ended by a genuine signal',
  async () => {
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    try {
      const prepared = trees.prepareTermination();
      await trees.end();
      prepared.release();
      await expect(body('/bin/echo', ['blocked'])).rejects.toThrow('The run owner is terminating');
    } finally {
      trees.release();
    }
  }
);

posixOnly.each(['end', 'timeout', 'abort'] as const)(
  'a reaped root is inspected without group signals on %s',
  async mode => {
    const dir = fixtureDir();
    const ready = join(dir, 'pids');
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    const controller = new AbortController();
    const node = runSubprocess(
      { kind: 'host' },
      '/bin/bash',
      ['-c', `/bin/sleep 30 & echo "$$ $!" > '${ready}'`],
      {
        cwd: dir,
        env: {},
        endTreeOnTimeout: true,
        timeout: mode === 'timeout' ? 1000 : undefined,
        abortSignal: controller.signal,
        retention: { standalone: true },
      }
    );
    const result = node.catch((error: RawSubprocessRejection) => error);
    let job: number | undefined;
    try {
      await waitUntil(() => existsSync(ready) && readFileSync(ready, 'utf8').trim() !== '');
      const [root, child] = readFileSync(ready, 'utf8').trim().split(' ').map(Number);
      job = child;
      await waitUntil(() => !alive(root));
      const signals = spyOn(process, 'kill');
      try {
        if (mode === 'end') {
          const prepared = trees.prepareTermination();
          expect(prepared.groups).toEqual([{ pgid: root, leaderReaped: true }]);
          const childGroup = Bun.spawnSync(['/bin/ps', '-p', String(job), '-o', 'pgid=']);
          expect(childGroup.exitCode).toBe(0);
          expect(Number(childGroup.stdout.toString().trim())).toBe(root);
          const processes = Bun.spawnSync(['/bin/ps', '-A', '-o', 'args=']).stdout.toString();
          expect(
            processes.split('\n').some(line => line.trim().endsWith(`archon-node-lifeline ${root}`))
          ).toBe(false);
          const warnings = await prepared.ready;
          expect(warnings).toEqual([
            expect.stringContaining("still holds the node's output"),
            expect.stringContaining('may have left untracked background work'),
          ]);
          await expect(trees.end()).rejects.toThrow('still running');
          prepared.release();
        } else {
          if (mode === 'abort') controller.abort();
          const error = await result;
          expect(error).toMatchObject({ treeSurvived: true, signal: null });
          expect(isSubprocessTimeout(error as RawSubprocessRejection)).toBe(false);
        }
        expect(alive(job)).toBe(true);
        expect(signals.mock.calls.filter(([pid]) => pid === -root)).toEqual([]);
      } finally {
        signals.mockRestore();
      }
    } finally {
      trees.prepareTermination().release();
      trees.release();
      if (job !== undefined) killFixture(job);
      await result;
    }
  },
  10000
);

posixOnly('failed inspection makes a detached timeout an ordinary cleanup failure', async () => {
  const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
  const inspection = spyOn(processTools, 'inspectProcessGroups').mockRejectedValue(
    new Error('ps failed')
  );
  try {
    const error = await failure(body('/bin/sleep', ['30'], 100));
    expect(error).toMatchObject({ treeSurvived: true });
    expect(error.message).toContain('ps failed');
    expect(isSubprocessTimeout(error)).toBe(false);
  } finally {
    inspection.mockRestore();
    trees.release();
  }
});

posixOnly(
  'a root ignoring SIGTERM is ended by exact PID without delayed group escalation',
  async () => {
    const dir = fixtureDir();
    const ready = join(dir, 'root');
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    const node = failure(
      body('/bin/bash', ['-c', `trap '' TERM; echo $$ > '${ready}'; exec /bin/sleep 30`], 1000)
    );
    try {
      await waitUntil(() => existsSync(ready) && readFileSync(ready, 'utf8').trim() !== '');
      const root = Number(readFileSync(ready, 'utf8'));
      const signals = spyOn(process, 'kill');
      try {
        const error = await node;
        expect(error).toMatchObject({ treeSurvived: true, signal: 'SIGKILL' });
        expect(isSubprocessTimeout(error)).toBe(false);
        expect(alive(root)).toBe(false);
        expect(signals.mock.calls.filter(([pid]) => pid === -root)).toEqual([[-root, 'SIGTERM']]);
      } finally {
        signals.mockRestore();
      }
    } finally {
      trees.release();
      if (existsSync(ready)) killFixture(Number(readFileSync(ready, 'utf8')));
      await node;
    }
  },
  10000
);

posixOnly(
  'preparation preserves syscall evidence and can retry after its last controller releases',
  async () => {
    const dir = fixtureDir();
    const ready = join(dir, 'root');
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    const node = failure(body('/bin/bash', ['-c', `echo $$ > '${ready}'; exec /bin/sleep 30`]));
    try {
      await waitUntil(() => existsSync(ready) && readFileSync(ready, 'utf8').trim() !== '');
      const root = Number(readFileSync(ready, 'utf8'));
      const signals = spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('fixture refusal'), { code: 'EPERM' });
      });
      try {
        const first = trees.prepareTermination();
        expect(first.groups).toEqual([{ pgid: root, leaderReaped: false, signalError: 'EPERM' }]);
        expect(trees.prepareTermination()).toBe(first);
        first.release();
      } finally {
        signals.mockRestore();
      }
      expect(alive(root)).toBe(true);
      const retry = trees.prepareTermination();
      expect(retry.groups).toEqual([{ pgid: root, leaderReaped: false }]);
      await waitUntil(() => !alive(root));
      retry.release();
      expect(await node).toMatchObject({ signal: 'SIGKILL' });
    } finally {
      trees.prepareTermination().release();
      trees.release();
      if (existsSync(ready)) killFixture(Number(readFileSync(ready, 'utf8')));
      await node;
    }
  }
);

posixOnly('a detached recorder leaves probes in the owner group', async () => {
  const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
  try {
    const ownerGroup = Bun.spawnSync(['/bin/ps', '-o', 'pgid=', '-p', String(process.pid)])
      .stdout.toString()
      .trim();
    const { stdout } = await runSubprocess(
      { kind: 'host' },
      '/bin/bash',
      ['-c', '/bin/ps -o pgid= -p $$'],
      {
        cwd: import.meta.dir,
        env: {},
        retention: { standalone: true },
      }
    );
    expect(stdout.trim()).toBe(ownerGroup);
    expect(trees.prepareTermination().groups).toEqual([]);
  } finally {
    trees.prepareTermination().release();
    trees.release();
  }
});

posixOnly.each(['timeout', 'abort', 'maxBuffer'] as const)(
  'retains the command through %s termination confirmation',
  async mode => {
    const dir = fixtureDir();
    const ready = join(dir, 'root');
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    const controller = new AbortController();
    let confirm!: () => void;
    let confirming = false;
    const confirmation = new Promise<void>(resolve => {
      confirm = resolve;
    });
    const inspect = spyOn(processTools, 'confirmProcessGroupsGone').mockImplementation(async () => {
      confirming = true;
      await confirmation;
    });
    const command =
      mode === 'maxBuffer'
        ? `echo $$ > '${ready}'; while :; do printf '%10000s' x; done`
        : `echo $$ > '${ready}'; exec /bin/sleep 30`;
    const result = failure(
      runSubprocess({ kind: 'host' }, '/bin/bash', ['-c', command], {
        cwd: dir,
        env: {},
        endTreeOnTimeout: true,
        timeout: mode === 'timeout' ? 200 : undefined,
        abortSignal: controller.signal,
        retention: { standalone: true },
      })
    );
    try {
      await waitUntil(() => existsSync(ready) && readFileSync(ready, 'utf8').trim() !== '');
      const root = Number(readFileSync(ready, 'utf8'));
      if (mode === 'abort') controller.abort();
      await waitUntil(() => confirming && !alive(root));
      await Bun.sleep(50);
      const prepared = trees.prepareTermination();
      expect(prepared.groups).toEqual([{ pgid: root, leaderReaped: true }]);
      confirm();
      prepared.release();
      await result;
      expect(trees.prepareTermination().groups).toEqual([]);
    } finally {
      confirm();
      inspect.mockRestore();
      trees.prepareTermination().release();
      trees.release();
      await result;
      if (existsSync(ready)) killFixture(Number(readFileSync(ready, 'utf8')));
    }
  }
);

posixOnly(
  'a live command with redirected escaped work reports uncertainty without signalling it',
  async () => {
    const dir = fixtureDir();
    const ready = join(dir, 'child');
    const wrapper = `const child = Bun.spawn(['/bin/sleep', '30'], {detached: true, stdio: ['ignore', 'ignore', 'ignore']}); require('fs').writeFileSync(${JSON.stringify(ready)}, String(child.pid)); await child.exited;`;
    const trees = recordNodeProcessTrees({ mode: 'detached-posix' });
    const node = failure(body(process.execPath, ['-e', wrapper]));
    let survivor: number | undefined;
    try {
      await waitUntil(() => existsSync(ready) && readFileSync(ready, 'utf8').trim() !== '');
      survivor = Number(readFileSync(ready, 'utf8'));
      const signals = spyOn(process, 'kill');
      try {
        const prepared = trees.prepareTermination();
        expect(await prepared.ready).toEqual([
          expect.stringContaining('may have left untracked background work'),
        ]);
        expect(signals.mock.calls.filter(([pid]) => Math.abs(pid) === survivor)).toEqual([]);
        expect(alive(survivor)).toBe(true);
        prepared.release();
      } finally {
        signals.mockRestore();
      }
      expect(await node).toMatchObject({ signal: 'SIGKILL' });
    } finally {
      trees.prepareTermination().release();
      trees.release();
      if (survivor !== undefined) killFixture(survivor);
      await node;
    }
  }
);
