import {
  registerContainerExecGate,
  type ContainerExecGate,
} from '@archon/provider-contract/container-exec';
import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { buildDockerExecArgs, buildContainerSpawn, type Spawner } from './container-spawn';

const CTX = { kind: 'container' as const, containerId: 'cid-123' };

function makeSpawnOptions(over: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    command: '/host/claude',
    args: ['--output-format', 'stream-json', '--verbose'],
    cwd: '/tmp/ops-client',
    env: { ANTHROPIC_API_KEY: 'sk-test', ARTIFACTS_DIR: '/a', PATH: '/host/bin', HOME: '/Users/x' },
    signal: new AbortController().signal,
    ...over,
  };
}

/** Fake ChildProcess with real streams + a recording kill(). */
function fakeChild(): ChildProcess & { killSignals: string[] } {
  const killSignals: string[] = [];
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    killSignals,
    kill: (signal?: NodeJS.Signals) => {
      killSignals.push(signal ?? 'SIGTERM');
      return true;
    },
  }) as unknown as ChildProcess & { killSignals: string[] };
}

/** Recording spawner returning a fresh fake child per call. */
function recordingSpawner(onSpawn?: (index: number) => void): Spawner & {
  calls: { command: string; args: string[] }[];
  children: ChildProcess[];
} {
  const calls: { command: string; args: string[] }[] = [];
  const children: ChildProcess[] = [];
  const fn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = fakeChild();
    children.push(child);
    onSpawn?.(children.length);
    return child;
  }) as unknown as Spawner & { calls: typeof calls; children: ChildProcess[] };
  fn.calls = calls;
  fn.children = children;
  return fn;
}

const PIDFILE = '/tmp/archon-claude-test.pid';

describe('buildDockerExecArgs', () => {
  test('builds docker exec -i with cwd, env flags, container id, pid-wrapped claude, and args', () => {
    const args = buildDockerExecArgs(CTX, makeSpawnOptions(), PIDFILE);
    expect(args.slice(0, 2)).toEqual(['exec', '-i']);
    expect(args).toContain('-w');
    const wIdx = args.indexOf('-w');
    expect(args[wIdx + 1]).toBe('/tmp/ops-client');
    expect(args).toContain('-e');
    expect(args).toContain('ANTHROPIC_API_KEY=sk-test');
    expect(args).toContain('ARTIFACTS_DIR=/a');
    // container id, then the pid-capturing shell wrapper, then $0 + the SDK args.
    const cidIdx = args.indexOf('cid-123');
    expect(cidIdx).toBeGreaterThan(-1);
    expect(args[cidIdx + 1]).toBe('sh');
    expect(args[cidIdx + 2]).toBe('-c');
    // The wrapper writes claude's own pid (via exec) to the pidfile.
    expect(args[cidIdx + 3]).toBe(`echo $$ > ${PIDFILE}; exec claude "$@"`);
    expect(args[cidIdx + 4]).toBe('claude'); // $0
    expect(args.slice(cidIdx + 5)).toEqual(['--output-format', 'stream-json', '--verbose']);
  });

  test('never forwards host PATH/HOME (container image provides them)', () => {
    const args = buildDockerExecArgs(CTX, makeSpawnOptions(), PIDFILE);
    const joined = args.join(' ');
    expect(joined).not.toContain('PATH=/host/bin');
    expect(joined).not.toContain('HOME=/Users/x');
  });

  test('adds -u when execUser is set', () => {
    const args = buildDockerExecArgs({ ...CTX, execUser: '1001' }, makeSpawnOptions(), PIDFILE);
    const uIdx = args.indexOf('-u');
    expect(uIdx).toBeGreaterThan(-1);
    expect(args[uIdx + 1]).toBe('1001');
  });
});

describe('buildContainerSpawn — SpawnedProcess contract', () => {
  test('spawns docker exec and exposes the child stdio', () => {
    const spawner = recordingSpawner();
    const proc = buildContainerSpawn(CTX, spawner)(makeSpawnOptions());
    expect(spawner.calls[0]?.command).toBe('docker');
    expect(spawner.calls[0]?.args.slice(0, 2)).toEqual(['exec', '-i']);
    expect(proc.stdin).toBe(spawner.children[0]?.stdin as never);
    expect(proc.stdout).toBe(spawner.children[0]?.stdout as never);
  });

  test('kill() targets THIS invocation pid in-container (not siblings) AND the local child', () => {
    const spawner = recordingSpawner();
    const proc = buildContainerSpawn(CTX, spawner)(makeSpawnOptions());
    proc.kill('SIGTERM');
    // The kill is a `docker exec <cid> sh -c '<pidfile kill script>'` — NOT pkill.
    const killCall = spawner.calls.find(c => c.args.some(a => a.includes('kill -TERM')));
    expect(killCall).toBeDefined();
    expect(killCall?.args[0]).toBe('exec');
    expect(killCall?.args).toContain('cid-123');
    expect(spawner.calls.some(c => c.args.includes('pkill'))).toBe(false);
    const script = killCall?.args.at(-1) ?? '';
    // Reads a per-invocation pidfile and signals the group (children) + the pid.
    expect(script).toMatch(/cat \/tmp\/archon-claude-[0-9a-f-]+\.pid/);
    expect(script).toContain('kill -TERM -"$pid"');
    expect(script).toContain('kill -TERM "$pid"');
    // Local docker-exec child was killed too.
    const mainChild = spawner.children[0] as ChildProcess & { killSignals: string[] };
    expect(mainChild.killSignals).toContain('SIGTERM');
  });

  test('propagates the exit event from the child', () => {
    const spawner = recordingSpawner();
    const proc = buildContainerSpawn(CTX, spawner)(makeSpawnOptions());
    let exitCode: number | null = -999;
    proc.on('exit', code => {
      exitCode = code;
    });
    (spawner.children[0] as EventEmitter).emit('exit', 0, null);
    expect(exitCode).toBe(0);
  });

  test('force-kills in-container (SIGKILL) when the forwarded abort signal fires', () => {
    const controller = new AbortController();
    const spawner = recordingSpawner();
    buildContainerSpawn(CTX, spawner)(makeSpawnOptions({ signal: controller.signal }));
    controller.abort();
    const killCall = spawner.calls.find(c => c.args.some(a => a.includes('kill -KILL')));
    expect(killCall).toBeDefined();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

function gateFixture() {
  let tail: Promise<unknown> = Promise.resolve();
  let failure: Error | undefined;
  const gate: ContainerExecGate = {
    run(operation) {
      const result = tail
        .catch(() => undefined)
        .then(() => {
          if (failure) throw failure;
          return operation();
        });
      tail = result;
      return result;
    },
    failAdmission(error) {
      failure = error;
    },
  };
  return gate;
}

describe('coordinated SDK spawn', () => {
  test.each(['kill', 'abort'] as const)(
    '%s waits through transfers and signals inside before killing the local client',
    async mode => {
      const context = { kind: 'container' as const, containerId: 'coordinated-sdk-' + mode };
      const gate = gateFixture();
      const unregister = registerContainerExecGate(context.containerId, gate);
      const started = deferred();
      const killerStarted = deferred();
      const spawner = recordingSpawner(index => {
        if (index === 1) started.resolve();
        else killerStarted.resolve();
      });
      const abort = new AbortController();
      const frozen = deferred();
      const thaw = deferred();
      try {
        const proc = buildContainerSpawn(
          context,
          spawner
        )(makeSpawnOptions({ signal: abort.signal }));
        const exiting = deferred();
        proc.on('exit', () => exiting.resolve());
        // stdin may be written before the queued spawn starts.
        proc.stdin.write('sdk payload');
        await started.promise;
        const child = spawner.children[0]!;
        const inputRead = new Promise<string>(resolve =>
          child.stdin?.once('data', chunk => resolve(String(chunk)))
        );
        expect(await inputRead).toBe('sdk payload');
        child.stdout?.emit('data', Buffer.from('sdk output'));
        expect(proc.stdout.read()?.toString()).toBe('sdk output');
        const script = spawner.calls[0]!.args.find(arg => arg.includes('printf'))!;
        expect(script.indexOf('echo $$')).toBeLessThan(script.indexOf('printf'));
        const marker = script.slice(script.indexOf("printf '") + 8, script.indexOf("' >&2"));
        const transfer = gate.run(async () => {
          frozen.resolve();
          await thaw.promise;
        });
        child.emit('spawn');
        await Promise.resolve();
        expect(spawner.calls).toHaveLength(1);
        child.stderr?.emit('data', Buffer.from(marker));
        await frozen.promise;
        if (mode === 'kill') proc.kill('SIGTERM');
        else abort.abort();
        expect(spawner.calls).toHaveLength(1);
        expect((child as ChildProcess & { killSignals: string[] }).killSignals).toEqual([]);
        thaw.resolve();
        await transfer;
        await killerStarted.promise;
        expect(spawner.calls).toHaveLength(2);
        const posix = mode === 'kill' ? 'TERM' : 'KILL';
        expect(spawner.calls[1]!.args.at(-1)).toContain(`kill -${posix}`);
        expect((child as ChildProcess & { killSignals: string[] }).killSignals).toEqual([]);
        spawner.children[1]!.emit('close', 0);
        await gate.run(async () => {});
        await Promise.resolve();
        expect((child as ChildProcess & { killSignals: string[] }).killSignals).toEqual([
          'SIG' + posix,
        ]);
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        await exiting.promise;
      } finally {
        thaw.resolve();
        unregister();
      }
    }
  );

  test('cancelling a queued spawn does not start a Docker exec', async () => {
    const gate = gateFixture();
    const context = { kind: 'container' as const, containerId: 'cancel-queued-sdk' };
    const unregister = registerContainerExecGate(context.containerId, gate);
    const frozen = deferred();
    const thaw = deferred();
    const transfer = gate.run(async () => {
      frozen.resolve();
      await thaw.promise;
    });
    await frozen.promise;
    const spawner = recordingSpawner();
    const proc = buildContainerSpawn(context, spawner)(makeSpawnOptions());
    const exited = deferred();
    proc.once('exit', () => exited.resolve());
    proc.kill('SIGTERM');
    try {
      thaw.resolve();
      await Promise.all([transfer, exited.promise]);
      expect(spawner.calls).toHaveLength(0);
    } finally {
      thaw.resolve();
      unregister();
    }
  });
});

test('an unconfirmed cancellation refuses subsequent transfers and retains the local client', async () => {
  const context = { kind: 'container' as const, containerId: 'failed-control-sdk' };
  const gate = gateFixture();
  const unregister = registerContainerExecGate(context.containerId, gate);
  const started = deferred();
  const killerStarted = deferred();
  const spawner = recordingSpawner(index => {
    if (index === 1) started.resolve();
    else killerStarted.resolve();
  });
  const proc = buildContainerSpawn(context, spawner)(makeSpawnOptions());
  const failed = new Promise<unknown>(resolve => proc.on('error', resolve));
  try {
    await started.promise;
    const script = spawner.calls[0]!.args.find(arg => arg.includes('printf'))!;
    spawner.children[0]!.stderr?.emit(
      'data',
      Buffer.from(script.slice(script.indexOf("printf '") + 8, script.indexOf("' >&2")))
    );
    await gate.run(async () => {});
    proc.kill('SIGKILL');
    await killerStarted.promise;
    const error = new Error('Docker signal client lost');
    spawner.children[1]!.emit('error', error);
    expect(await failed).toBe(error);
    await expect(gate.run(async () => {})).rejects.toThrow('signal delivery is unconfirmed');
    expect((spawner.children[0] as ChildProcess & { killSignals: string[] }).killSignals).toEqual(
      []
    );
  } finally {
    spawner.children[0]?.emit('exit', 0, null);
    spawner.children[0]?.emit('close', 0, null);
    unregister();
  }
});
