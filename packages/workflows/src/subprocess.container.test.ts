// @archon-test-isolated
import { expect, it, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as git from '@archon/git';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runSubprocessUntilRunStops } from './dag/run-control';
import { WorkflowStatusReadError } from './workflow-status-read';
import { runSubprocess } from './subprocess';
import { mockLogFn } from './dag/test-utils';

const trackTempRoot = trackTempRoots();

it
  .skipIf(process.platform === 'win32')
  .each(['status', 'cancelled', 'termination failure'] as const)(
  'ends the in-container command before returning %s',
  async kind => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'container-node-')));
    const exec = git.execFileAsync;
    const previousPath = process.env.PATH;
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh
while [ "$1" != scratch-container ]; do shift; done
shift
[ "$1" != setsid ] || shift
exec "$@"
`,
      { mode: 0o755 }
    );
    process.env.PATH = `${dir}:${previousPath}`;
    const execSpy = spyOn(git, 'execFileAsync').mockImplementation(async (cmd, args, options) => {
      if (cmd !== 'docker') return exec(cmd, args, options);
      const remote = args.slice(args.indexOf('scratch-container') + 1);
      if (kind === 'termination failure' && remote.join(' ').includes('kill -KILL')) {
        throw new Error('Docker control failed');
      }
      return exec(remote[0]!, remote.slice(1), options);
    });
    const failure = new WorkflowStatusReadError('scratch', new Error('Unsupported status'));
    mockLogFn.mockClear();
    try {
      const pending = runSubprocessUntilRunStops(
        {
          getWorkflowRunStatus: async () => {
            if (!existsSync(join(dir, 'started'))) return 'running';
            if (kind === 'cancelled') return 'cancelled';
            throw failure;
          },
        },
        'scratch',
        'work',
        { kind: 'container', containerId: 'scratch-container' },
        'sh',
        ['-c', 'touch started; (sleep 2; touch leaked) & wait'],
        {
          cwd: dir,
          env: {},
          retention: { standalone: true },
        }
      );
      const sibling = runSubprocess(
        { kind: 'container', containerId: 'scratch-container' },
        'sh',
        ['-c', 'cat; sleep 2; touch sibling'],
        {
          cwd: dir,
          env: {},
          input: '€ exact stdin\n',
          retention: { standalone: true },
          abortSignal: new AbortController().signal,
        }
      );
      if (kind === 'cancelled') await expect(pending).rejects.toMatchObject({ cancelled: true });
      else await expect(pending).rejects.toBe(failure);
      expect((await sibling).stdout).toBe('€ exact stdin\n');
      await Bun.sleep(200);
      expect(existsSync(join(dir, 'sibling'))).toBe(true);
      expect(existsSync(join(dir, 'leaked'))).toBe(false);
      expect(
        execSpy.mock.calls.some(([, args]) => args.some(arg => arg.includes('kill -KILL')))
      ).toBe(true);
      if (kind === 'termination failure') {
        expect(mockLogFn).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.objectContaining({
              cause: expect.objectContaining({ message: 'Docker control failed' }),
            }),
          }),
          'dag.status_error_subprocess_tree_survived'
        );
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      execSpy.mockRestore();
    }
  }
);

it('refuses an already-aborted container invocation before spawning it', async () => {
  const controller = new AbortController();
  controller.abort();
  const spy = spyOn(childProcess, 'spawn');
  try {
    await expect(
      runSubprocess({ kind: 'container', containerId: 'not-started' }, 'sh', ['-c', 'true'], {
        cwd: '/tmp',
        env: {},
        retention: { standalone: true },
        abortSignal: controller.signal,
      })
    ).rejects.toMatchObject({ cancelled: true });
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
