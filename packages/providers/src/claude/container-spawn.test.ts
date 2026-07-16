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
  const emitter = new EventEmitter() as ChildProcess & { killSignals: string[] };
  emitter.stdin = new PassThrough() as unknown as ChildProcess['stdin'];
  emitter.stdout = new PassThrough() as unknown as ChildProcess['stdout'];
  emitter.killed = false;
  emitter.exitCode = null;
  emitter.killSignals = [];
  emitter.kill = ((signal?: NodeJS.Signals) => {
    emitter.killSignals.push(signal ?? 'SIGTERM');
    return true;
  }) as ChildProcess['kill'];
  return emitter;
}

/** Recording spawner returning a fresh fake child per call. */
function recordingSpawner(): Spawner & {
  calls: { command: string; args: string[] }[];
  children: ChildProcess[];
} {
  const calls: { command: string; args: string[] }[] = [];
  const children: ChildProcess[] = [];
  const fn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = fakeChild();
    children.push(child);
    return child;
  }) as Spawner & { calls: typeof calls; children: ChildProcess[] };
  fn.calls = calls;
  fn.children = children;
  return fn;
}

describe('buildDockerExecArgs', () => {
  test('builds docker exec -i with cwd, env flags, container id, claude, and args', () => {
    const args = buildDockerExecArgs(CTX, makeSpawnOptions());
    expect(args.slice(0, 2)).toEqual(['exec', '-i']);
    expect(args).toContain('-w');
    const wIdx = args.indexOf('-w');
    expect(args[wIdx + 1]).toBe('/tmp/ops-client');
    expect(args).toContain('-e');
    expect(args).toContain('ANTHROPIC_API_KEY=sk-test');
    expect(args).toContain('ARTIFACTS_DIR=/a');
    // container id, then the in-container binary, then the SDK args
    const cidIdx = args.indexOf('cid-123');
    expect(cidIdx).toBeGreaterThan(-1);
    expect(args[cidIdx + 1]).toBe('claude');
    expect(args.slice(cidIdx + 2)).toEqual(['--output-format', 'stream-json', '--verbose']);
  });

  test('never forwards host PATH/HOME (container image provides them)', () => {
    const args = buildDockerExecArgs(CTX, makeSpawnOptions());
    const joined = args.join(' ');
    expect(joined).not.toContain('PATH=/host/bin');
    expect(joined).not.toContain('HOME=/Users/x');
  });

  test('adds -u when execUser is set', () => {
    const args = buildDockerExecArgs({ ...CTX, execUser: '1001' }, makeSpawnOptions());
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

  test('kill() signals the in-container process AND the local exec child', () => {
    const spawner = recordingSpawner();
    const proc = buildContainerSpawn(CTX, spawner)(makeSpawnOptions());
    proc.kill('SIGTERM');
    // Second spawn is the in-container pkill.
    const pkillCall = spawner.calls.find(c => c.args.includes('pkill'));
    expect(pkillCall).toBeDefined();
    expect(pkillCall?.args).toEqual(['exec', 'cid-123', 'pkill', '-TERM', '-f', 'claude']);
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

  test('force-kills in-container when the forwarded abort signal fires', () => {
    const controller = new AbortController();
    const spawner = recordingSpawner();
    buildContainerSpawn(CTX, spawner)(makeSpawnOptions({ signal: controller.signal }));
    controller.abort();
    const pkillCall = spawner.calls.find(c => c.args.includes('pkill'));
    expect(pkillCall?.args).toContain('-KILL');
  });
});
