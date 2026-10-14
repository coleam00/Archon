import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  isSubprocessTimeout,
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
