import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { getLogLevel, setLogLevel, setLogSink } from './logger';
import * as identities from './windows-process-identity';
import type { WindowsProcessIdentity } from './windows-process-identity';
import {
  confirmProcessGroupsGone,
  inspectProcessGroups,
  terminateWindowsTree,
} from './plugin-process';

describe('inspectProcessGroups', () => {
  test('selects matching numeric groups', async () => {
    expect(await inspectProcessGroups([12], async () => ' 12\n 120\n 12\n')).toEqual([12, 12]);
  });

  test('distinguishes no members from failed or malformed inspection', async () => {
    expect(await inspectProcessGroups([12], async () => '')).toEqual([]);
    await expect(
      inspectProcessGroups([12], async () => {
        throw new Error('ps refused');
      })
    ).rejects.toThrow('ps refused');
    await expect(inspectProcessGroups([12], async () => 'invalid listing')).rejects.toThrow(
      'Invalid POSIX process listing'
    );
    await expect(inspectProcessGroups([12], async () => '99999999999999999')).rejects.toThrow(
      'Invalid POSIX process identifier'
    );
  });

  test.skipIf(process.platform === 'win32')(
    'inspects a real group and confirms its disappearance',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      if (child.pid === undefined) throw new Error('Fixture failed to spawn');
      const exited = once(child, 'exit');
      try {
        const members = await inspectProcessGroups([child.pid]);
        expect(members).toContain(child.pid);
        await expect(confirmProcessGroupsGone([child.pid], 0)).rejects.toThrow('still running');
      } finally {
        child.kill('SIGKILL');
        await exited;
      }
      await confirmProcessGroupsGone([child.pid], 1000);
    }
  );
});

const taskkillExit = (code: number) => (): Promise<never> =>
  Promise.reject(Object.assign(new Error(`taskkill exited ${code}`), { code }));

describe('terminateWindowsTree', () => {
  test('resolves when taskkill exits 255 and the root is gone', async () => {
    const child = Bun.spawn([process.execPath, '-e', '']);
    await child.exited;
    await terminateWindowsTree(child.pid, taskkillExit(255));
  });

  test('rejects with the taskkill error when the root is still alive', async () => {
    await expect(terminateWindowsTree(process.pid, taskkillExit(255))).rejects.toThrow(
      'taskkill exited 255'
    );
  });
});

describe('Windows stop diagnostics', () => {
  const pid = 123;
  const entry: WindowsProcessIdentity = { pid, status: 'observed', creationTicks: '100' };
  const originalLevel = getLogLevel();
  let lines: string[];
  let identity: ReturnType<typeof spyOn<typeof identities, 'readWindowsProcessIdentity'>>;
  const spies: { mockRestore(): void }[] = [];

  beforeEach(() => {
    lines = [];
    setLogLevel('debug');
    setLogSink(line => {
      lines.push(line);
    });
    identity = spyOn(identities, 'readWindowsProcessIdentity').mockResolvedValue(entry);
    spies.push(identity);
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    setLogSink(undefined);
    setLogLevel(originalLevel);
  });

  const failure = () =>
    Object.assign(new Error('SECRET_MESSAGE'), {
      code: 128,
      stderr: Buffer.from('requested stderr'),
      cmd: 'SECRET_CMD',
      stdout: 'SECRET_STDOUT',
      stack: 'SECRET_STACK',
    });

  // Exercise false despite Node's true-only declaration: it must never prove death.
  test.each([true, false, 'ESRCH', 'EPERM', 'EOTHER', undefined])(
    'logs the single deciding probe %p and preserves the taskkill error',
    async outcome => {
      const kill = spyOn(process, 'kill').mockImplementation((() => {
        if (typeof outcome === 'boolean') return outcome;
        throw Object.assign(new Error('SECRET_PROBE'), { code: outcome, errno: -42 });
      }) as typeof process.kill);
      spies.push(kill);
      const error = failure();
      const result = await terminateWindowsTree(pid, async target => {
        expect(target).toBe(pid);
        throw error;
      }).then(
        () => 'resolved',
        caught => caught
      );
      expect(result).toBe(outcome === 'ESRCH' ? 'resolved' : error);
      expect(kill.mock.calls).toEqual([[pid, 0]]);
      expect(identity.mock.calls).toEqual([[pid], [pid]]);
      const events = lines.map(line => JSON.parse(line));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: outcome === 'ESRCH' ? 20 : 40,
        module: 'paths.plugin-process',
        msg: 'process.windows_tree_stop',
        targetPid: pid,
        phase: 'taskkill_failed',
        entryIdentity: entry,
        failureIdentity: entry,
        taskkill: { code: 128, stderr: 'requested stderr' },
        liveness:
          typeof outcome === 'boolean'
            ? { status: 'returned', value: outcome }
            : {
                status: 'threw',
                code: outcome ?? null,
                errno: -42,
              },
      });
      expect(lines.join('')).not.toContain('SECRET');
    }
  );

  const samples: WindowsProcessIdentity[] = [
    entry,
    { pid, status: 'observed', creationTicks: '200' },
    { pid, status: 'absent' },
    { pid, status: 'unavailable', code: 5 },
  ];
  for (const sample of samples) {
    test.each(['ESRCH', 'EPERM'])(
      `identity ${sample.status} cannot change %p decision`,
      async code => {
        identity.mockResolvedValueOnce(entry).mockResolvedValueOnce(sample);
        spies.push(
          spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('probe'), { code });
          })
        );
        const error = failure();
        const result = await terminateWindowsTree(pid, async () => {
          throw error;
        }).then(
          () => 'resolved',
          caught => caught
        );
        expect(result).toBe(code === 'ESRCH' ? 'resolved' : error);
        expect(JSON.parse(lines[0])).toMatchObject({
          entryIdentity: entry,
          failureIdentity: sample,
        });
      }
    );
  }

  test('info-level rethrow logs at warn with a post-failure identity sample', async () => {
    setLogLevel('info');
    spies.push(spyOn(process, 'kill').mockReturnValue(true));
    const error = failure();
    await expect(
      terminateWindowsTree(pid, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(identity.mock.calls).toEqual([[pid]]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 40,
      module: 'paths.plugin-process',
      msg: 'process.windows_tree_stop',
      targetPid: pid,
      phase: 'taskkill_failed',
      failureIdentity: entry,
      liveness: { status: 'returned', value: true },
      taskkill: { code: 128, stderr: 'requested stderr' },
    });
    expect(JSON.parse(lines[0])).not.toHaveProperty('entryIdentity');
    expect(lines.join('')).not.toContain('SECRET');

    lines.length = 0;
    identity.mockClear();
    spies.push(
      spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      })
    );
    await terminateWindowsTree(pid, async () => {
      throw error;
    });
    await terminateWindowsTree(pid, async () => {});
    expect(identity).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  test('successful taskkill never probes liveness, takes a failure snapshot or emits diagnostics', async () => {
    const kill = spyOn(process, 'kill').mockReturnValue(true);
    spies.push(kill);
    await terminateWindowsTree(pid, async () => {});
    expect(kill).not.toHaveBeenCalled();
    expect(identity).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  test.each(['ESRCH', 'EPERM'])(
    'capture and sink failures cannot replace %p result',
    async code => {
      identity.mockRejectedValue(new Error('capture failed'));
      spies.push(
        spyOn(process, 'kill').mockImplementation(() => {
          throw Object.assign(new Error('probe'), { code });
        })
      );
      const error = failure();
      const stop = () =>
        terminateWindowsTree(pid, async () => {
          throw error;
        }).then(
          () => 'resolved',
          caught => caught
        );
      expect(await stop()).toBe(code === 'ESRCH' ? 'resolved' : error);
      expect(JSON.parse(lines[0])).toMatchObject({
        entryIdentity: { pid, status: 'unavailable', code: 'CAPTURE_FAILED' },
        failureIdentity: { pid, status: 'unavailable', code: 'CAPTURE_FAILED' },
      });
      setLogSink(() => {
        throw new Error('sink failed');
      });
      expect(await stop()).toBe(code === 'ESRCH' ? 'resolved' : error);
      await terminateWindowsTree(pid, async () => {});
    }
  );

  for (const field of ['code', 'stderr', 'toString'] as const) {
    test.each(['ESRCH', 'EPERM'])(
      `throwing taskkill ${field} cannot replace %p result`,
      async code => {
        spies.push(
          spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('probe'), { code });
          })
        );
        const error = failure();
        const fail = () => {
          throw new Error('diagnostic field failed');
        };
        if (field === 'toString') error.stderr.toString = fail;
        else Object.defineProperty(error, field, { get: fail });
        const result = await terminateWindowsTree(pid, async () => {
          throw error;
        }).then(
          () => 'resolved',
          caught => caught
        );
        expect(result).toBe(code === 'ESRCH' ? 'resolved' : error);
        expect(lines).toEqual([]);
      }
    );
  }

  test.each(['ENOENT', undefined])(
    'logs launch failure %p with explicit unavailable fields',
    async code => {
      spies.push(
        spyOn(process, 'kill').mockImplementation(((): boolean => false) as typeof process.kill)
      );
      const error = Object.assign(new Error('SECRET'), { code });
      await expect(
        terminateWindowsTree(pid, async () => {
          throw error;
        })
      ).rejects.toBe(error);
      expect(JSON.parse(lines[0]).taskkill).toEqual({ code: code ?? null, stderr: null });
      expect(JSON.parse(lines[0]).liveness).toEqual({
        status: 'returned',
        value: false,
      });
      expect(lines.join('')).not.toContain('SECRET');
    }
  );
});

describe('Windows capture ordering', () => {
  test('samples entry, taskkill, deciding probe, then failure identity in that order', async () => {
    const order: string[] = [];
    const previousLevel = getLogLevel();
    let samples = 0;
    const identity = spyOn(identities, 'readWindowsProcessIdentity').mockImplementation(
      async pid => {
        order.push(++samples === 1 ? 'entry' : 'failure');
        return { pid, status: 'absent' };
      }
    );
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      order.push('probe');
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    try {
      setLogLevel('debug');
      const lines: string[] = [];
      setLogSink(line => {
        lines.push(line);
      });
      await terminateWindowsTree(123, async () => {
        order.push('taskkill');
        throw Object.assign(new Error('failed'), { code: 128, stderr: 'stderr string' });
      });
      expect(order).toEqual(['entry', 'taskkill', 'probe', 'failure']);
      expect(JSON.parse(lines[0]).taskkill).toEqual({ code: 128, stderr: 'stderr string' });
    } finally {
      identity.mockRestore();
      kill.mockRestore();
      setLogSink(undefined);
      setLogLevel(previousLevel);
    }
  });
});
