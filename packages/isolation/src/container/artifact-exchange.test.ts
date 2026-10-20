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
  test('collects from a running producer without freezing it and removes the helper', async () => {
    const f = fixture();
    await f.exchange.collect();
    expect(verbs(f.calls)).toEqual(['container', 'volume', 'create', 'start', 'wait', 'rm']);
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
    expect(verbs(f.calls)).toEqual(['container', 'volume', 'create', 'start', 'wait']);
    release?.();
    await Promise.all([first, second, lifecycle]);
    expect(verbs(f.calls)).toEqual([
      'container',
      'volume',
      'create',
      'start',
      'wait',
      'rm',
      'container',
      'volume',
      'create',
      'start',
      'wait',
      'rm',
      'container',
      'lifecycle',
    ]);
  });

  test('does not infer stopped ownership from an inspection failure', async () => {
    const f = fixture({
      fail: args => (args[0] === 'container' ? new Error('daemon unavailable') : undefined),
    });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(verbs(f.calls).includes('create')).toBe(false);
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
    expect(verbs(f.calls)).toEqual(['container']);
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
      expect(verbs(f.calls)).toEqual(['container', 'volume']);
    }
  );

  test('preserves helper and helper-removal failures', async () => {
    const removalFailure = new Error('rm failed');
    const f = fixture({
      exitCode: '1',
      fail: args => (args[0] === 'rm' ? removalFailure : undefined),
    });
    try {
      await f.exchange.collect();
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const failures = (error as AggregateError).errors;
      expect(failures).toHaveLength(2);
      expect(failures[0].message).toContain('refused');
      expect(failures[1]).toBe(removalFailure);
    }
  });

  test('removes a timed-out helper', async () => {
    const f = fixture({ fail: args => (args[0] === 'wait' ? new Error('timeout') : undefined) });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(verbs(f.calls).at(-1)).toBe('rm');
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
        if (args[0] === 'volume' && !failed) {
          failed = true;
          return new Error('volume listing unavailable');
        }
        return undefined;
      },
    });
    await expect(f.exchange.collect()).rejects.toThrow();
    expect(await f.exchange.serialize(async () => 'operator action')).toBe('operator action');
  });
});
