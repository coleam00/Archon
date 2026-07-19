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

describe('buildDockerExecArgs — container workdir + pathMap extension', () => {
  // Our WSL sandbox mounts the worktree at /work, NOT at the host cwd, so the
  // execContext carries an in-container workdir + a host→container path map.
  const WORKTREE = '/home/bunny/archon/worktrees/marphob-page/s1';
  const CTX_MAPPED = {
    kind: 'container' as const,
    containerId: 'cid-123',
    workdir: '/work',
    pathMap: [{ hostPrefix: WORKTREE, containerPrefix: '/work' }],
  };

  test('emits -w workdir (not the host cwd) when workdir is set', () => {
    const args = buildDockerExecArgs(CTX_MAPPED, makeSpawnOptions({ cwd: WORKTREE }), PIDFILE);
    const wIdx = args.indexOf('-w');
    expect(args[wIdx + 1]).toBe('/work');
  });

  test('remaps a forwarded env path value under a host mount prefix', () => {
    const args = buildDockerExecArgs(
      CTX_MAPPED,
      makeSpawnOptions({ cwd: WORKTREE, env: { DOCS_DIR: `${WORKTREE}/docs`, KEEP: 'plain' } }),
      PIDFILE
    );
    expect(args).toContain('DOCS_DIR=/work/docs');
    expect(args).toContain('KEEP=plain'); // non-path value untouched
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
