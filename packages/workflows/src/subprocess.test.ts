// @archon-test-isolated
import { describe, expect, it, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '@archon/git';
import { bashInvocation } from './bash-invocation';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  buildSubprocessDockerArgs,
  containerCommandName,
  isSubprocessTimeout,
  recordNodeProcessTrees,
  runSubprocess,
  type RawSubprocessRejection,
} from './subprocess';

const trackTempRoot = trackTempRoots();
const posixOnly = process.platform === 'win32' ? test.skip : test;

function runHostBash(script: string, timeout?: number): ReturnType<typeof runSubprocess> {
  const invocation = bashInvocation(script);
  return runSubprocess({ kind: 'host' }, git.resolveBashPath(), invocation.args, {
    input: invocation.input,
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
    const node = runHostBash(`/bin/sleep 30 & echo $! > '${pidFile}'; wait`);
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
    const node = runHostBash(`/bin/sleep 30 & echo $! > '${pidFile}'`);
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

posixOnly('a recorded node without a declared timeout arms no deadline', async () => {
  const trees = recordNodeProcessTrees();
  const timers = spyOn(globalThis, 'setTimeout');
  try {
    await runHostBash('printf undeclared');
    expect(timers).not.toHaveBeenCalled();
    await runHostBash('printf declared', 5000);
    expect(timers.mock.calls.map(call => call[1])).toEqual([5000]);
  } finally {
    timers.mockRestore();
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

posixOnly('a recorded node timeout without endTreeOnTimeout ends its root only', async () => {
  const pidFile = join(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-tree-'))), 'pid');
  const trees = recordNodeProcessTrees();
  let job: number | undefined;
  try {
    const error = await runHostBash(
      `/bin/sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exec /bin/sleep 5`,
      200
    ).then(
      () => undefined,
      (e: unknown) => e as RawSubprocessRejection
    );
    expect(error && isSubprocessTimeout(error)).toBe(true);
    job = Number(readFileSync(pidFile, 'utf8'));
    expect(processExists(job)).toBe(true);
  } finally {
    trees.release();
    if (job !== undefined && processExists(job)) process.kill(job, 'SIGKILL');
  }
});

posixOnly('an unrecorded POSIX node stays in its owner process group', async () => {
  const ownerGroup = Bun.spawnSync(['/bin/ps', '-o', 'pgid=', '-p', String(process.pid)])
    .stdout.toString()
    .trim();
  const { stdout } = await runSubprocess(
    { kind: 'host' },
    '/bin/bash',
    ['-c', '/bin/ps -o pgid= -p $$'],
    {
      cwd: import.meta.dir,
      timeout: 5000,
      env: {},
      endTreeOnTimeout: true,
      retention: { standalone: true },
    }
  );
  expect(stdout.trim()).toBe(ownerGroup);
});

// A wrapper runtime (`bun run`, `uv run`) starts the real work as a grandchild. The node's
// timeout must end that grandchild too, before the timeout is reported.
async function expectTimeoutEndsGrandchild(): Promise<void> {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-timeout-')));
  const started = join(dir, 'started');
  const marker = join(dir, 'marker');
  const grandchild =
    "require('fs').writeFileSync(process.env.STARTED, ''); " +
    "setTimeout(() => require('fs').writeFileSync(process.env.MARKER, 'leaked'), 2500);";
  const wrapper = `await Bun.spawn([process.execPath, '-e', ${JSON.stringify(grandchild)}]).exited;`;
  const error = await runSubprocess({ kind: 'host' }, process.execPath, ['-e', wrapper], {
    input: '',
    cwd: dir,
    timeout: 1500,
    env: { STARTED: started, MARKER: marker },
    endTreeOnTimeout: true,
    retention: { standalone: true },
  }).then(
    () => undefined,
    (e: unknown) => e as RawSubprocessRejection
  );
  expect(error && isSubprocessTimeout(error)).toBe(true);
  expect(error?.signal).toBe('SIGTERM');
  expect(existsSync(started)).toBe(true);
  await new Promise<void>(resolve => setTimeout(resolve, 3000));
  expect(existsSync(marker)).toBe(false);
}

test('a recorded node timeout ends the wrapper and its grandchild', async () => {
  const trees = recordNodeProcessTrees();
  try {
    await expectTimeoutEndsGrandchild();
  } finally {
    trees.release();
  }
}, 15_000);

test.skipIf(process.platform !== 'win32')(
  'an unrecorded Windows node timeout ends the wrapper and its grandchild',
  expectTimeoutEndsGrandchild,
  15_000
);

// A stopped run aborts its node: the whole tree ends, whichever process holds the work,
// with no declared deadline to fall back on.
async function runAbortedWrapper(): Promise<{
  error: RawSubprocessRejection | undefined;
  leaked: boolean;
}> {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-abort-')));
  const started = join(dir, 'started');
  const marker = join(dir, 'marker');
  const grandchild =
    "require('fs').writeFileSync(process.env.STARTED, ''); " +
    "setTimeout(() => require('fs').writeFileSync(process.env.MARKER, 'leaked'), 1500);";
  const wrapper = `await Bun.spawn([process.execPath, '-e', ${JSON.stringify(grandchild)}]).exited;`;
  const controller = new AbortController();
  const node = runSubprocess({ kind: 'host' }, process.execPath, ['-e', wrapper], {
    input: '',
    cwd: dir,
    env: { STARTED: started, MARKER: marker },
    endTreeOnTimeout: true,
    abortSignal: controller.signal,
    retention: { standalone: true },
  }).then(
    () => undefined,
    (e: unknown) => e as RawSubprocessRejection
  );
  await waitUntil('the grandchild to start', () => existsSync(started));
  controller.abort();
  const error = await node;
  await new Promise<void>(resolve => setTimeout(resolve, 2000));
  return { error, leaked: existsSync(marker) };
}

test('aborting a recorded node ends the wrapper and its grandchild', async () => {
  const trees = recordNodeProcessTrees();
  try {
    const { error, leaked } = await runAbortedWrapper();
    expect(error?.message).toBe('Command cancelled');
    expect(error?.cancelled).toBe(true);
    expect(error && isSubprocessTimeout(error)).toBe(false);
    expect(leaked).toBe(false);
  } finally {
    trees.release();
  }
}, 15_000);

test('an unrecorded node ignores the abort, because its owner ends it', async () => {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-abort-')));
  const controller = new AbortController();
  controller.abort();
  const { stdout } = await runSubprocess(
    { kind: 'host' },
    process.execPath,
    ['-e', 'await Bun.sleep(200); console.log("finished")'],
    {
      cwd: dir,
      timeout: 5000,
      env: {},
      endTreeOnTimeout: true,
      abortSignal: controller.signal,
      retention: { standalone: true },
    }
  );
  expect(stdout.trim()).toBe('finished');
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

posixOnly('evidence keeps no GitHub App token a command obtained after it started', async () => {
  // Stands in for the App-mode gh shim: the token is minted inside the child, so it is
  // not among the credential values runSubprocess collected before spawning.
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-minted-token-')));
  const helper = join(dir, 'git-credential-archon');
  writeFileSync(helper, '#!/bin/sh\nprintf "password=ghs_%sMintedInsideTheChild0123\\n" "$$"\n', {
    mode: 0o755,
  });
  const obtain = `token=$(printf 'host=github.com\\n\\n' | ${helper} get | sed -n 's/^password=//p')`;
  const logDir = join(dir, 'logs');
  const run = (script: string): ReturnType<typeof runSubprocess> =>
    runSubprocess({ kind: 'host' }, '/bin/bash', ['-c', script], {
      cwd: import.meta.dir,
      timeout: 5000,
      env: {},
      retention: { logDir, workflowRunId: 'run-1', nodeId: 'node-1', label: 'bash' },
    });

  await run(`${obtain}; printf 'token=%s' "$token"; printf 'stderr %s' "$token" >&2`);
  const failure = (await run(
    `${obtain}; printf 'out %s' "$token"; printf 'auth failed with %s' "$token" >&2; exit 1`
  ).catch((error: unknown) => error)) as RawSubprocessRejection;

  expect(failure.stderr).toBe('auth failed with [REDACTED]');
  expect(failure.stdout).toBe('out [REDACTED]');
  expect(failure.message).not.toContain('ghs_');
  const retained = readdirSync(logDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
  expect(retained).toContain('token=[REDACTED]');
  expect(retained).toContain('auth failed with [REDACTED]');
  expect(retained).not.toContain('ghs_');
});

describe('containerCommandName', () => {
  it('returns a bare command unchanged', () => {
    expect(containerCommandName('bash')).toBe('bash');
    expect(containerCommandName('bun')).toBe('bun');
  });

  it('strips a unix directory to the basename', () => {
    expect(containerCommandName('/usr/local/bin/bash')).toBe('bash');
  });

  it('strips a Windows path + .exe (container is always Linux)', () => {
    expect(containerCommandName('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash');
  });
});

describe('subprocess input delivery', () => {
  it.each([false, true])('delivers Unicode and EOF with recording=%s', async recorded => {
    const trees = recorded ? recordNodeProcessTrees() : undefined;
    try {
      for (const input of ["€\nquote' \\ $()`\n\n", '']) {
        expect(
          await runSubprocess(
            { kind: 'host' },
            process.execPath,
            ['-e', 'process.stdout.write(require("node:fs").readFileSync(0))'],
            {
              cwd: import.meta.dir,
              env: {},
              retention: { standalone: true },
              input,
            }
          )
        ).toMatchObject({ stdout: input, stderr: '' });
      }
    } finally {
      trees?.release();
    }
  });

  it('keeps command failure primary and rejects unsuccessful delivery in recorded nodes', async () => {
    const trees = recordNodeProcessTrees();
    const run = (code: number) =>
      runSubprocess(
        { kind: 'host' },
        process.execPath,
        [
          '-e',
          `require('node:fs').closeSync(0); process.stderr.write('evidence'); setTimeout(() => process.exit(${code}), 100)`,
        ],
        {
          cwd: import.meta.dir,
          env: {},
          retention: { standalone: true },
          input: 'x'.repeat(8_000_000),
        }
      );
    try {
      await expect(run(7)).rejects.toMatchObject({ code: 7, stderr: 'evidence' });
      await expect(run(0)).rejects.toMatchObject({ code: expect.any(String), stderr: 'evidence' });
    } finally {
      trees.release();
    }
  });

  it.each([undefined, '', '€\nexact\n'])(
    'forwards input %j through Docker without putting it in argv',
    async input => {
      const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'ok', stderr: '' });
      try {
        const invocation = bashInvocation(input ?? '');
        await runSubprocess(
          { kind: 'container', containerId: 'payload-container', execUser: '1000' },
          git.resolveBashPath(),
          invocation.args,
          {
            cwd: '/workspace',
            env: { KEEP: 'yes', HOME: '/denied' },
            retention: { standalone: true },
            input,
          }
        );
        expect(execSpy).toHaveBeenCalledWith(
          'docker',
          [
            'exec',
            '-w',
            '/workspace',
            ...(input !== undefined ? ['-i'] : []),
            '-u',
            '1000',
            '-e',
            'KEEP=yes',
            'payload-container',
            'bash',
            ...invocation.args,
          ],
          { input, timeout: undefined }
        );
      } finally {
        execSpy.mockRestore();
      }
    }
  );
});

describe('buildSubprocessDockerArgs — bash/script env isolation', () => {
  const CTX = { kind: 'container' as const, containerId: 'cid-9' };

  it('delivers the Archon-managed env via -e flags only and runs at the same cwd', () => {
    const args = buildSubprocessDockerArgs(CTX, 'bash', ['-c', 'echo hi'], {
      cwd: '/tmp/ops-client',
      env: { ARTIFACTS_DIR: '/a', ANTHROPIC_API_KEY: 'sk', BASE_BRANCH: 'main' },
    });
    expect(args.slice(0, 2)).toEqual(['exec', '-w']);
    expect(args[2]).toBe('/tmp/ops-client');
    // Every managed var is delivered as an explicit -e flag.
    expect(args).toContain('-e');
    expect(args).toContain('ARTIFACTS_DIR=/a');
    expect(args).toContain('ANTHROPIC_API_KEY=sk');
    expect(args).toContain('BASE_BRANCH=main');
    // Container id, then the normalized command, then the node args.
    const cidIdx = args.indexOf('cid-9');
    expect(cidIdx).toBeGreaterThan(-1);
    expect(args[cidIdx + 1]).toBe('bash');
    expect(args.slice(cidIdx + 2)).toEqual(['-c', 'echo hi']);
  });

  it('does NOT leak host process.env (only the passed env bag is forwarded)', () => {
    const canary = 'ARCHON_DAGEXEC_CANARY';
    process.env[canary] = 'leaked';
    try {
      const args = buildSubprocessDockerArgs(CTX, 'bash', ['-c', 'true'], {
        cwd: '/w',
        env: { ONLY_THIS: '1' },
      });
      const joined = args.join(' ');
      expect(joined).toContain('ONLY_THIS=1');
      expect(joined).not.toContain(canary);
    } finally {
      delete process.env[canary];
    }
  });

  it('normalizes a host bash path to the in-container binary name', () => {
    const args = buildSubprocessDockerArgs(CTX, '/usr/local/bin/bash', ['-c', 'x'], {
      cwd: '/w',
      env: {},
    });
    const cidIdx = args.indexOf('cid-9');
    expect(args[cidIdx + 1]).toBe('bash');
  });

  it('never forwards denylisted keys (PATH/HOME) — a project env var must not clobber resolution', () => {
    const args = buildSubprocessDockerArgs(CTX, 'bash', ['-c', 'true'], {
      cwd: '/w',
      env: { PATH: '/evil/bin', HOME: '/evil', PWD: '/x', KEEP: '1' },
    });
    const joined = args.join(' ');
    expect(joined).not.toContain('PATH=/evil/bin');
    expect(joined).not.toContain('HOME=/evil');
    expect(joined).not.toContain('PWD=/x');
    expect(joined).toContain('KEEP=1'); // non-denylisted keys still forwarded
  });
});
