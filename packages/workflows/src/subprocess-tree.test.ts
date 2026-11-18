// @archon-test-isolated
// @archon-test-windows
/**
 * A node's timeout or abort ends the whole process tree, wrapper and grandchild, on every OS.
 * Windows ends a tree with taskkill rather than a process group, so these run in the Windows
 * set; the rest of the subprocess tests live in subprocess.test.ts.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
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

async function waitUntil(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

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
  try {
    await waitUntil('the grandchild to start', () => existsSync(started));
  } catch (readiness) {
    // The caller releases the recorder next, so the tree is ended and settled first. `node`
    // never rejects, so the readiness error stays the one reported.
    controller.abort();
    await node;
    throw readiness;
  }
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

test.skipIf(process.platform === 'win32')(
  'an unrecorded POSIX fallback ignores abort',
  async () => {
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
  }
);

test.skipIf(process.platform !== 'win32')(
  'an unrecorded Windows node abort ends the wrapper and its grandchild',
  async () => {
    const { error, leaked } = await runAbortedWrapper();
    expect(error?.cancelled).toBe(true);
    expect(leaked).toBe(false);
  },
  15_000
);
