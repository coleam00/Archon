import { describe, expect, test } from 'bun:test';
import { ContainerArtifactExchange, type ArtifactExchangeTarget } from './artifact-exchange';
import type { DockerRunner } from './docker-exec';

const target: ArtifactExchangeTarget = {
  container: 'producer',
  helper: 'producer-artifact-helper',
  volume: 'archon-output',
  root: '/host/run/artifacts',
  image: 'runner:test',
};

function fixture(
  options: {
    state?: string;
    helperExists?: boolean;
    fail?: (args: string[]) => unknown;
    beforeWait?: () => Promise<void>;
    exitCode?: string;
    missingVolume?: boolean;
  } = {}
) {
  const calls: string[][] = [];
  let state = options.state ?? 'running';
  let helperExists = options.helperExists ?? false;
  const docker: DockerRunner = async args => {
    calls.push(args);
    const failure = options.fail?.(args);
    if (failure) throw failure;
    switch (args[0]) {
      case 'container':
        return {
          stdout: [
            ...(state === 'missing'
              ? []
              : [{ Names: target.container, ID: 'producer-id', State: state }]),
            ...(helperExists ? [{ Names: target.helper, ID: 'helper-id', State: 'running' }] : []),
          ]
            .map(entry => JSON.stringify(entry))
            .join('\n'),
          stderr: '',
        };
      case 'volume':
        return { stdout: options.missingVolume ? '' : target.volume, stderr: '' };
      case 'pause':
        state = 'paused';
        break;
      case 'unpause':
        state = 'running';
        break;
      case 'create':
        helperExists = true;
        return { stdout: 'helper-id\n', stderr: '' };
      case 'wait':
        await options.beforeWait?.();
        return { stdout: options.exitCode ?? '0', stderr: '' };
      case 'logs':
        return { stdout: '', stderr: 'Artifact exchange refused a linked parent' };
      case 'rm':
        helperExists = false;
        break;
    }
    return { stdout: '', stderr: '' };
  };
  return { exchange: new ContainerArtifactExchange(docker, target), calls, state: () => state };
}

function verbs(calls: string[][]) {
  return calls.map(args => args[0]);
}

describe('ContainerArtifactExchange', () => {
  test('freezes the producer until the helper has exited and been removed', async () => {
    const f = fixture();
    await f.exchange.collect();
    expect(verbs(f.calls)).toEqual([
      'container',
      'pause',
      'volume',
      'create',
      'start',
      'wait',
      'rm',
      'unpause',
    ]);
    expect(f.state()).toBe('running');
  });

  test.each(['publish', 'collect'] as const)(
    '%s mounts only the appropriate destination writable',
    async direction => {
      const f = fixture();
      await f.exchange[direction]();
      const args = f.calls.find(call => call[0] === 'create') ?? [];
      expect(args).toContain(`${target.root}:/canonical${direction === 'publish' ? ':ro' : ''}`);
      expect(args).toContain(`${target.volume}:/output${direction === 'collect' ? ':ro' : ''}`);
      expect(args).toContain('DAC_OVERRIDE');
      expect(args.includes('CHOWN')).toBe(direction === 'collect');
      expect(args.join(' ')).toContain('--cap-drop ALL');
      expect(args.join(' ')).toContain('--network none');
      expect(args.join(' ')).toContain('--security-opt no-new-privileges');
      expect(args.join(' ')).toContain('--entrypoint bun');
      expect(args).toContain('--no-env-file');
      expect(args).not.toContain('SYS_ADMIN');
      expect(args).not.toContain('--privileged');
      expect(args.some(arg => arg.includes('docker.sock'))).toBe(false);
    }
  );

  test('serializes transfers and lifecycle operations while allowing invocation work elsewhere', async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    let arrived: (() => void) | undefined;
    const atWait = new Promise<void>(resolve => {
      arrived = resolve;
    });
    const f = fixture({
      beforeWait: async () => {
        arrived?.();
        await waiting;
      },
    });
    const first = f.exchange.collect();
    await atWait;
    const second = f.exchange.publish();
    const lifecycle = f.exchange.serialize(async () => {
      f.calls.push(['lifecycle']);
    });
    expect(verbs(f.calls)).toEqual(['container', 'pause', 'volume', 'create', 'start', 'wait']);
    release?.();
    await Promise.all([first, second, lifecycle]);
    expect(verbs(f.calls)).toEqual([
      'container',
      'pause',
      'volume',
      'create',
      'start',
      'wait',
      'rm',
      'unpause',
      'container',
      'pause',
      'volume',
      'create',
      'start',
      'wait',
      'rm',
      'unpause',
      'container',
      'lifecycle',
    ]);
  });

  test('starts no helper if freezing fails', async () => {
    const failure = new Error('pause failed');
    const f = fixture({ fail: args => (args[0] === 'pause' ? failure : undefined) });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(verbs(f.calls)).toEqual(['container', 'pause']);
  });

  test('does not infer stopped ownership from an inspection failure', async () => {
    const f = fixture({
      fail: args => (args[0] === 'container' ? new Error('daemon unavailable') : undefined),
    });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(verbs(f.calls).includes('create')).toBe(false);
    expect(verbs(f.calls).includes('unpause')).toBe(false);
  });

  test.each(['paused', 'restarting', 'removing', 'unknown'])(
    'refuses producer state %s without changing it',
    async state => {
      const f = fixture({ state });
      await expect(f.exchange.collect()).rejects.toThrow();
      expect(verbs(f.calls)).toEqual(['container']);
      expect(f.state()).toBe(state);
    }
  );

  test('refuses an existing helper without claiming or removing it', async () => {
    const f = fixture({ helperExists: true });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(verbs(f.calls)).toEqual(['container', 'container']);
  });

  test.each(['missing', 'exited', 'created', 'dead'])(
    'collects surviving output from %s producer and skips unnecessary publish',
    async state => {
      const f = fixture({ state });
      await f.exchange.publish();
      expect(verbs(f.calls)).toEqual(['container']);
      await f.exchange.collect();
      expect(verbs(f.calls)).toEqual([
        'container',
        'container',
        'volume',
        'create',
        'start',
        'wait',
        'rm',
      ]);
    }
  );

  test.each(['publish', 'collect'] as const)(
    '%s never auto-creates a missing output volume',
    async direction => {
      const f = fixture({ missingVolume: true });
      await expect(f.exchange[direction]()).rejects.toThrow();
      expect(verbs(f.calls)).toEqual(['container', 'pause', 'volume', 'unpause']);
    }
  );

  test('preserves helper and unpause failures', async () => {
    const unpauseFailure = new Error('unpause failed');
    const f = fixture({
      exitCode: '1',
      fail: args => (args[0] === 'unpause' ? unpauseFailure : undefined),
    });
    try {
      await f.exchange.collect();
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const failures = (error as AggregateError).errors;
      expect(failures).toHaveLength(2);
      expect(failures[0].message).toContain('refused');
      expect(failures[1]).toBe(unpauseFailure);
    }
    expect(verbs(f.calls).slice(-2)).toEqual(['rm', 'unpause']);
  });

  test('removes a timed-out helper before unfreezing the producer', async () => {
    const f = fixture({ fail: args => (args[0] === 'wait' ? new Error('timeout') : undefined) });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(verbs(f.calls).slice(-2)).toEqual(['rm', 'unpause']);
  });

  test('leaves producer paused when helper completion cannot be confirmed', async () => {
    const f = fixture({
      fail: args => (['wait', 'rm'].includes(args[0]) ? new Error('daemon lost') : undefined),
    });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(f.state()).toBe('paused');
    expect(verbs(f.calls)).not.toContain('unpause');
    expect(verbs(f.calls).at(-1)).toBe('container');
  });

  test('does not reclaim a helper after losing its creation acknowledgement', async () => {
    let inspections = 0;
    const f = fixture({
      fail: args => {
        if (args[0] === 'create') return new Error('reply lost');
        if (args[0] === 'container' && ++inspections > 1) return new Error('inspection lost');
        return undefined;
      },
    });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(f.state()).toBe('paused');
    expect(verbs(f.calls)).not.toContain('rm');
    expect(verbs(f.calls)).not.toContain('unpause');
  });

  test('lifecycle operations can collect while holding the shared queue', async () => {
    const f = fixture({ state: 'exited' });
    await f.exchange.serialize(async collect => {
      f.calls.push(['lifecycle']);
      await collect();
    });
    expect(verbs(f.calls)).toEqual([
      'container',
      'lifecycle',
      'container',
      'volume',
      'create',
      'start',
      'wait',
      'rm',
    ]);
  });

  test.each([
    { state: 'paused' },
    { state: 'restarting' },
    { state: 'removing' },
    { helperExists: true },
  ])('refuses lifecycle mutation when ownership is ambiguous: %j', async options => {
    const f = fixture(options);
    let mutated = false;
    await expect(
      f.exchange.serialize(async () => {
        mutated = true;
      })
    ).rejects.toThrow('ownership is ambiguous');
    expect(mutated).toBe(false);
    expect(verbs(f.calls)).toEqual(['container']);
  });

  test('a refused operation does not poison the serialization queue', async () => {
    let failed = false;
    const f = fixture({
      fail: args => {
        if (args[0] === 'pause' && !failed) {
          failed = true;
          return new Error('pause unavailable');
        }
        return undefined;
      },
    });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(await f.exchange.serialize(async () => 'operator action')).toBe('operator action');
  });
});
