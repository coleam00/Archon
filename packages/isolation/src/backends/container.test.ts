import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveBashPath } from '@archon/git';
import { getArchonHome, getRunScratchDir } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { OVERLAY_MODES } from '@archon/workflows/container-context';
import { ContainerBackend } from './container';
import * as containerModule from './container';
import type { ContainerBackendConfig } from '../types';
import type { IIsolationStore } from '../store';
import type { IsolationEnvironmentRow, CreateEnvironmentParams } from '../types';
import type { DockerRunner, DockerExecResult } from '../container/docker-exec';
import { IsolationFailure, isKnownIsolationError } from '../errors';

const CONFIG: ContainerBackendConfig = {
  image: 'archon-runner:test',
  network: 'bridge',
  memoryMb: 4096,
  pidsLimit: 512,
};

const FOLDER = {
  id: 'cb-1',
  defaultCwd: '/tmp/ops-client',
  name: 'ops-client',
  kind: 'folder' as const,
};

/** In-memory store capturing the created row and exposing it for destroy(). */
function fakeStore(): IIsolationStore & {
  rows: Map<string, IsolationEnvironmentRow>;
  created?: CreateEnvironmentParams;
} {
  const rows = new Map<string, IsolationEnvironmentRow>();
  let counter = 0;
  return {
    rows,
    created: undefined,
    async getById(id) {
      return rows.get(id) ?? null;
    },
    listActive: async () => [],
    async findActiveByWorkflow() {
      return null;
    },
    async create(env) {
      this.created = env;
      const row: IsolationEnvironmentRow = {
        id: `env-${++counter}`,
        codebase_id: env.codebase_id,
        workflow_type: env.workflow_type,
        workflow_id: env.workflow_id,
        provider: env.provider ?? 'container',
        working_path: env.working_path,
        branch_name: env.branch_name,
        status: 'active',
        created_at: new Date(),
        created_by_platform: env.created_by_platform ?? null,
        created_by_user_id: env.created_by_user_id ?? null,
        metadata: env.metadata ?? {},
      };
      rows.set(row.id, row);
      return row;
    },
    async updateMetadata(id, metadata) {
      const row = rows.get(id);
      if (!row) throw new Error('Missing environment');
      row.metadata = { ...row.metadata, ...metadata };
    },
    async updateStatus(id, status) {
      const row = rows.get(id);
      if (row) row.status = status;
    },
    withWorktreeRegistration: async () => {
      throw new Error('Unexpected worktree removal');
    },
    async markWorktreeDestroyed() {
      throw new Error('Unexpected worktree retirement');
    },
    async countActiveByCodebase() {
      return 0;
    },
  };
}

/**
 * Build a DockerRunner from a per-command handler. `handler` returns the result
 * or throws; unmatched commands return empty stdout. Records every call.
 */
function fakeDocker(
  handler: (args: string[]) => DockerExecResult | Promise<DockerExecResult>
): DockerRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (async (args: string[]) => {
    calls.push(args);
    return handler(args);
  }) as DockerRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

describe('runner overlay modes', () => {
  test.each([...OVERLAY_MODES, 'unsupported'])('accepts only host modes: %s', mode => {
    const entrypoint = readFileSync(new URL('../../docker/entrypoint.sh', import.meta.url), 'utf8');
    const runner = spawnSync(
      resolveBashPath(),
      [
        '-c',
        `
        rm() { :; }
        mkdir() { :; }
        touch() { :; }
        fuse-overlayfs() { echo mount:fuse; }
        mount() { echo mount:native; }
        exec() { :; }
        export ARCHON_WORKSPACE_PATH=/workspace ARCHON_OVERLAY_MODE="$1"
        ${entrypoint.replaceAll('/tmp/overlay-fuse.err', '/dev/null').replaceAll('/tmp/overlay-native.err', '/dev/null')}
        `,
        'runner-mode-test',
        mode,
      ],
      { encoding: 'utf8' }
    );
    expect(runner.error).toBeUndefined();
    expect(runner.signal).toBeNull();
    if (mode === 'unsupported') {
      expect(runner.status).toBe(1);
      expect(runner.stdout).not.toContain('mount:');
    } else {
      expect(runner.status).toBe(0);
      expect(runner.stdout).toContain(`mount:${mode}`);
    }
  });
});

describe('ContainerBackend.prepare', () => {
  test.each(['run', 'exec', 'inspect', 'logs', 'rm'] as const)(
    'a Docker %s outage cannot trigger privileged fallback even if the next run would succeed',
    async phase => {
      const store = fakeStore();
      const failure = new IsolationFailure('unclassified', 'Docker daemon unavailable');
      let now = 0;
      const clock = spyOn(Date, 'now').mockImplementation(() => now);
      let runs = 0;
      const docker = fakeDocker(args => {
        if (args[0] === 'run') {
          runs++;
          if (runs === 1 && phase === 'run') throw failure;
          return { stdout: 'cid', stderr: '' };
        }
        if (runs > 1) return { stdout: '', stderr: '' };
        if (args[0] === phase) {
          now += 30_000;
          throw failure;
        }
        if (args[0] === 'exec') throw new IsolationFailure('unclassified', 'not ready');
        if (args[0] === 'inspect') {
          if (phase === 'exec') throw failure;
          return {
            stdout:
              args.includes('{{.State.ExitCode}}') && ['logs', 'rm'].includes(phase)
                ? '78'
                : 'false',
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });
      try {
        const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
        await expect(backend.prepare({ codebase: FOLDER })).rejects.toBeInstanceOf(
          IsolationFailure
        );
        expect(runs).toBe(1);
        expect(docker.calls.some(args => args.includes('SYS_ADMIN'))).toBe(false);
        expect(store.created).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    }
  );

  test.each(['run', 'ready'] as const)(
    'preserves typed %s failures without trying a more privileged mode',
    async phase => {
      const store = fakeStore();
      const failures: IsolationFailure[] = [];
      const docker = fakeDocker(args => {
        if ((args[0] === 'run' && phase === 'run') || (args[0] === 'exec' && phase === 'ready')) {
          const cause = Object.assign(new Error('process failed'), {
            code: 125,
            stderr: 'permission denied: fix/timeout-retry',
          });
          const failure = new IsolationFailure(
            'unclassified',
            `docker ${args[0]} failed: ${cause.stderr} (exit code 125)`,
            cause
          );
          failures.push(failure);
          throw failure;
        }
        if (args[0] === 'run') return { stdout: 'cid', stderr: '' };
        if (args[0] === 'inspect') return { stdout: 'false', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      const error = await backend.prepare({ codebase: FOLDER }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(IsolationFailure);
      if (!(error instanceof IsolationFailure)) throw new Error('expected isolation failure');
      expect(error.kind).toBe('unclassified');
      expect(isKnownIsolationError(error)).toBe(false);
      if (phase === 'run') expect(error).toBe(failures[0]);
      else {
        expect(error.message).toContain('docker exec failed');
        expect(error.message).toContain('permission denied: fix/timeout-retry');
        expect(error.message).toContain('exit code 125');
        expect(error.cause).toBeInstanceOf(AggregateError);
        if (!(error.cause instanceof AggregateError))
          throw new Error('expected readiness failures');
        expect(error.cause.errors).toEqual(failures);
        expect(failures[0]?.cause).toMatchObject({ code: 125 });
      }
      expect(store.created).toBeUndefined();
    }
  );

  test.each(
    [TypeError, ReferenceError].flatMap(ErrorType =>
      ['run', 'exec', 'inspect', 'logs', 'version', 'image'].map(
        phase => [phase, ErrorType] as const
      )
    )
  )(
    'propagates a programming failure in %s without trying another overlay mode',
    async (phase, ErrorType) => {
      const failure = new ErrorType('invalid Docker options');
      const store = fakeStore();
      const docker = fakeDocker(args => {
        if (args[0] === phase) throw failure;
        if (args[0] === 'run') return { stdout: 'cid', stderr: '' };
        if (args[0] === 'exec') throw new IsolationFailure('unclassified', 'not ready');
        if (args[0] === 'inspect') return { stdout: 'false', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({
        store,
        config: CONFIG,
        dockerRunner: docker,
      });
      await expect(backend.prepare({ codebase: FOLDER })).rejects.toBe(failure);
      const started = ['exec', 'inspect', 'logs'].includes(phase);
      expect(docker.calls.filter(args => args[0] === 'run')).toHaveLength(
        ['version', 'image'].includes(phase) ? 0 : 1
      );
      expect(docker.calls.filter(args => args[0] === 'rm')).toHaveLength(started ? 1 : 0);
      expect(docker.calls.filter(args => args[0] === 'volume' && args[1] === 'rm')).toHaveLength(
        ['version', 'image'].includes(phase) ? 0 : 1
      );
      expect(store.rows.size).toBe(0);
      expect(store.created).toBeUndefined();
    }
  );

  test.each(['inspect', 'logs'])(
    'retains a failed %s check alongside the exec evidence on readiness failure',
    async phase => {
      const execFailure = new IsolationFailure('unclassified', 'docker exec failed: exit code 1');
      const cause = Object.assign(new Error('process failed'), {
        code: 23,
        stderr: 'original evidence',
      });
      const failure = new IsolationFailure(
        'unclassified',
        `docker ${phase} failed: original evidence (exit code 23)`,
        cause
      );
      let now = 0;
      const clock = spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const docker = fakeDocker(args => {
          if (args[0] === 'run') return { stdout: 'cid', stderr: '' };
          if (args[0] === 'exec') throw execFailure;
          if (args[0] === phase) {
            now += 30_000;
            throw failure;
          }
          if (args[0] === 'inspect') return { stdout: 'false', stderr: '' };
          return { stdout: '', stderr: '' };
        });
        const backend = new ContainerBackend({
          store: fakeStore(),
          config: CONFIG,
          dockerRunner: docker,
        });
        const error = await backend.prepare({ codebase: FOLDER }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(IsolationFailure);
        if (!(error instanceof IsolationFailure) || !(error.cause instanceof AggregateError)) {
          throw new Error('expected attempt failures');
        }
        expect(error.message).toContain(`docker ${phase} failed`);
        expect(error.message).toContain('original evidence (exit code 23)');
        expect(error.cause.errors).toEqual([execFailure, failure]);
        expect(failure.cause).toBe(cause);
      } finally {
        clock.mockRestore();
      }
    }
  );

  test('prefers fuse mode (no CAP_SYS_ADMIN) with labels, mounts, and resource limits', async () => {
    const store = fakeStore();
    const docker = fakeDocker(args => {
      if (args[0] === 'version') return { stdout: '28', stderr: '' };
      if (args[0] === 'image') return { stdout: '[]', stderr: '' };
      if (args[0] === 'volume') return { stdout: '', stderr: '' };
      if (args[0] === 'run') return { stdout: 'abc123containerid\n', stderr: '' };
      if (args[0] === 'exec') return { stdout: '', stderr: '' }; // ready poll succeeds → fuse wins
      return { stdout: '', stderr: '' };
    });

    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });

    expect(prepared.cwd).toBe('/tmp/ops-client');
    expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'abc123containerid' });
    expect(prepared.envId).toBe('env-1');

    const runArgs = docker.calls.find(c => c[0] === 'run');
    expect(runArgs).toBeDefined();
    const joined = (runArgs ?? []).join(' ');
    expect(joined).toContain('--label diy.archon.managed=true');
    expect(joined).toContain('--label diy.archon.codebase-id=cb-1');
    // Fuse mode: the device, and CRUCIALLY no CAP_SYS_ADMIN (closes the remount escape).
    expect(joined).toContain('--device /dev/fuse');
    expect(joined).toContain('ARCHON_OVERLAY_MODE=fuse');
    expect(joined).not.toContain('--cap-add SYS_ADMIN');
    expect(joined).toContain('--restart no');
    expect(joined).toContain('--memory 4096m');
    expect(joined).toContain('--pids-limit 512');
    expect(joined).toContain('--network bridge');
    expect(joined).toContain('/tmp/ops-client:/mnt/lower:ro');
    expect(joined).toContain('ARCHON_WORKSPACE_PATH=/tmp/ops-client');
    expect(joined).toContain('archon-runner:test');
    // The winning mode is recorded on the row metadata.
    expect((store.created?.metadata as { overlayMode: string }).overlayMode).toBe('fuse');

    // The upper volume carries the same managed label as the container, so leak
    // detection + cleanup can discover BOTH resource types by label.
    const volumeCreate = docker.calls.find(c => c[0] === 'volume' && c[1] === 'create');
    expect(volumeCreate?.join(' ')).toContain('--label diy.archon.managed=true');
  });

  test.each(['0', '1', '137', '178', 'unknown'])(
    'does not escalate for an exited container with status %s',
    async exitCode => {
      const store = fakeStore();
      const docker = fakeDocker(args => {
        if (args[0] === 'run') return { stdout: 'cid', stderr: '' };
        if (args[0] === 'exec') throw new IsolationFailure('unclassified', 'not ready');
        if (args[0] === 'inspect')
          return {
            stdout: args.includes('{{.State.ExitCode}}') ? exitCode : 'false',
            stderr: '',
          };
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      await expect(backend.prepare({ codebase: FOLDER })).rejects.toBeInstanceOf(IsolationFailure);
      expect(docker.calls.filter(args => args[0] === 'run')).toHaveLength(1);
      expect(docker.calls.some(args => args.includes('SYS_ADMIN'))).toBe(false);
      expect(store.created).toBeUndefined();
    }
  );

  test.each([
    ...OVERLAY_MODES.map(mode => [mode, 'none', 0, mode === 'fuse'] as const),
    ['fuse', 'rm', 73, false],
    ['fuse', 'rm', 78, false],
    ['fuse', 'mkdir', 73, false],
    ['fuse', 'mkdir', 78, false],
  ] as const)(
    'runner %s failure (%s exits %s) permits native fallback: %s',
    async (mode, startupCommand, startupStatus, fallback) => {
      const entrypoint = readFileSync(
        new URL('../../docker/entrypoint.sh', import.meta.url),
        'utf8'
      );
      const runner = spawnSync(
        resolveBashPath(),
        [
          '-c',
          `
      rm() { return ${startupCommand === 'rm' ? startupStatus : 0}; }
      mkdir() { return ${startupCommand === 'mkdir' ? startupStatus : 0}; }
      fuse-overlayfs() { return 1; }
      mount() { return 1; }
      export ARCHON_WORKSPACE_PATH=/workspace ARCHON_OVERLAY_MODE=${mode}
      ${entrypoint.replaceAll('/tmp/overlay-fuse.err', '/dev/null').replaceAll('/tmp/overlay-native.err', '/dev/null')}
    `,
        ],
        { encoding: 'utf8' }
      );
      expect(runner.error).toBeUndefined();
      expect(runner.signal).toBeNull();
      expect(runner.status).not.toBeNull();
      expect(runner.status).not.toBe(0);
      const store = fakeStore();
      let runCount = 0;
      const docker = fakeDocker(args => {
        if (args[0] === 'run') {
          runCount += 1;
          return { stdout: `cid-${runCount}\n`, stderr: '' };
        }
        // Fuse container: ready check fails AND inspect says not running → fast fail.
        // Native container (2nd run): ready check passes.
        if (args[0] === 'exec' && args.includes('test')) {
          if (runCount === 1) throw new IsolationFailure('unclassified', 'not ready');
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'inspect')
          return {
            stdout: args.includes('{{.State.ExitCode}}') ? `${runner.status}\n` : 'false\n',
            stderr: '',
          };
        if (args[0] === 'rm') return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      if (!fallback) {
        await expect(backend.prepare({ codebase: FOLDER })).rejects.toBeInstanceOf(
          IsolationFailure
        );
        expect(runCount).toBe(1);
        expect(docker.calls.some(args => args.includes('SYS_ADMIN'))).toBe(false);
        return;
      }
      const prepared = await backend.prepare({ codebase: FOLDER });

      expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-2' });
      expect(runCount).toBe(2);
      // The failed fuse container is removed before the native attempt.
      expect(docker.calls.find(c => c[0] === 'rm')).toBeDefined();
      // The 2nd run (native) carries CAP_SYS_ADMIN, not the fuse device.
      const nativeRun = docker.calls.filter(c => c[0] === 'run')[1];
      const joined = (nativeRun ?? []).join(' ');
      expect(joined).toContain('--cap-add SYS_ADMIN');
      expect(joined).toContain('ARCHON_OVERLAY_MODE=native');
      expect(joined).not.toContain('/dev/fuse');
      expect((store.created?.metadata as { overlayMode: string }).overlayMode).toBe('native');
    }
  );

  test('stores a container row with the empty-branch sentinel and container metadata', async () => {
    const store = fakeStore();
    const docker = fakeDocker(args => {
      if (args[0] === 'run') return { stdout: 'cid\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await backend.prepare({ codebase: FOLDER });

    expect(store.created?.provider).toBe('container');
    expect(store.created?.branch_name).toBe('' as never);
    expect(store.created?.working_path).toBe('/tmp/ops-client');
    const meta = store.created?.metadata as { containerId: string; volume: string; image: string };
    expect(meta.containerId).toBe('cid');
    expect(meta.image).toBe('archon-runner:test');
    expect(meta.volume).toMatch(/^archon-.*-upper$/);
  });

  test('polls until the overlay-ready sentinel appears (container still running)', async () => {
    const store = fakeStore();
    let readyChecks = 0;
    const docker = fakeDocker(args => {
      if (args[0] === 'run') return { stdout: 'cid\n', stderr: '' };
      if (args[0] === 'exec' && args.includes('test')) {
        readyChecks += 1;
        if (readyChecks < 2) throw new IsolationFailure('unclassified', 'sentinel not present yet');
        return { stdout: '', stderr: '' };
      }
      // Container is still running while we poll → waitForReady keeps polling
      // (does not fast-fail out to the next mode).
      if (args[0] === 'inspect') return { stdout: 'true\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });
    expect(prepared.envId).toBe('env-1');
    expect(readyChecks).toBeGreaterThanOrEqual(2);
  });

  test('removes the volume if docker run fails (no leak)', async () => {
    const store = fakeStore();
    const docker = fakeDocker(args => {
      if (args[0] === 'run') throw new IsolationFailure('unclassified', 'docker: some run failure');
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.prepare({ codebase: FOLDER })).rejects.toThrow(/run failure/);
    const volumeRm = docker.calls.find(c => c[0] === 'volume' && c[1] === 'rm');
    expect(volumeRm).toBeDefined();
  });

  test('removes the container + volume if store.create rejects (no orphan)', async () => {
    const store = fakeStore();
    // Container starts + becomes ready (fuse wins), but the row insert fails.
    store.create = async () => {
      throw new Error('db insert failed');
    };
    const docker = fakeDocker(args => {
      if (args[0] === 'run') return { stdout: 'cid\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.prepare({ codebase: FOLDER })).rejects.toThrow(/db insert failed/);
    // Both the container and the volume are cleaned up before rethrow.
    expect(docker.calls.find(c => c[0] === 'rm' && c[1] === '-f')).toBeDefined();
    expect(docker.calls.find(c => c[0] === 'volume' && c[1] === 'rm')).toBeDefined();
  });

  test.each(['{{.State.Running}}', '{{.State.ExitCode}}'])(
    'a recovered %s inspection permits confirmed FUSE fallback after cleanup',
    async failedInspection => {
      const store = fakeStore();
      let runs = 0;
      let inspectionFailed = false;
      const docker = fakeDocker(args => {
        if (args[0] === 'run') {
          runs++;
          return { stdout: `cid-${runs}\n`, stderr: '' };
        }
        if (args[0] === 'exec' && args.includes('test') && runs === 1)
          throw new IsolationFailure('unclassified', 'sentinel absent');
        if (args[0] === 'inspect') {
          if (args.includes(failedInspection) && !inspectionFailed) {
            inspectionFailed = true;
            throw new IsolationFailure('unclassified', 'temporary inspection failure');
          }
          return {
            stdout: args.includes('{{.State.ExitCode}}') ? '78\n' : 'false\n',
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      const prepared = await backend.prepare({ codebase: FOLDER });
      expect(inspectionFailed).toBe(true);
      expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-2' });
      expect(store.created?.metadata).toMatchObject({ overlayMode: 'native' });
      const fuseRun = docker.calls.find(args => args[0] === 'run');
      const containerName = fuseRun?.[fuseRun.indexOf('--name') + 1];
      const cleanup = docker.calls.findIndex(
        args => args[0] === 'rm' && args.at(-1) === containerName
      );
      const privilegedRun = docker.calls.findIndex(
        args => args[0] === 'run' && args.includes('SYS_ADMIN')
      );
      expect(cleanup).toBeGreaterThanOrEqual(0);
      expect(privilegedRun).toBeGreaterThan(cleanup);
      expect(runs).toBe(2);
    }
  );

  test('a transient inspect ERROR does NOT trigger the native fallback (keeps polling)', async () => {
    const store = fakeStore();
    let runCount = 0;
    let readyChecks = 0;
    const docker = fakeDocker(args => {
      if (args[0] === 'run') {
        runCount += 1;
        return { stdout: `cid-${runCount}\n`, stderr: '' };
      }
      if (args[0] === 'exec' && args.includes('test')) {
        readyChecks += 1;
        // Not ready on the first poll, ready on the second.
        if (readyChecks < 2) throw new IsolationFailure('unclassified', 'sentinel not present yet');
        return { stdout: '', stderr: '' };
      }
      // Inspect ERRORS (transient) → must be treated as 'unknown', NOT 'stopped',
      // so the poll continues on the SAME (fuse) container instead of falling back.
      if (args[0] === 'inspect')
        throw new IsolationFailure('unclassified', 'Cannot connect to the Docker daemon');
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });
    // Only ONE run — fuse succeeded; the inspect blip did NOT escalate to native.
    expect(runCount).toBe(1);
    expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-1' });
    expect((store.created?.metadata as { overlayMode: string }).overlayMode).toBe('fuse');
  });

  test('rejects an unclassified fuse run failure even when its text names a missing device', async () => {
    const store = fakeStore();
    let runAttempts = 0;
    const docker = fakeDocker(args => {
      if (args[0] === 'run') {
        runAttempts += 1;
        // Fuse attempt carries --device /dev/fuse and the daemon refuses it.
        if (args.includes('/dev/fuse')) {
          const err = new Error('run failed') as Error & { stderr?: string };
          err.stderr =
            'error gathering device information while adding custom device "/dev/fuse": no such file or directory';
          throw new IsolationFailure('unclassified', err.stderr ?? err.message, err);
        }
        return { stdout: 'cid-nofuse\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.prepare({ codebase: FOLDER })).rejects.toBeInstanceOf(IsolationFailure);
    expect(runAttempts).toBe(1);
    expect(store.created).toBeUndefined();
  });
});

describe('ContainerBackend.destroy', () => {
  test('removes container + volume and marks the row destroyed', async () => {
    const store = fakeStore();
    const docker = fakeDocker(args => {
      if (args[0] === 'run') return { stdout: 'cid\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });
    docker.calls.length = 0;

    await backend.destroy(prepared.envId as string);

    const rm = docker.calls.find(c => c[0] === 'rm');
    const volumeRm = docker.calls.find(c => c[0] === 'volume' && c[1] === 'rm');
    expect(rm).toBeDefined();
    expect(volumeRm).toBeDefined();
    expect(store.rows.get(prepared.envId as string)?.status).toBe('destroyed');
  });

  test('propagates a status write failure after removing both resources', async () => {
    const store = fakeStore();
    const docker = fakeDocker(args => ({ stdout: args[0] === 'run' ? 'cid\n' : '', stderr: '' }));
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });
    const failure = new Error('status write failed');
    spyOn(store, 'updateStatus').mockRejectedValueOnce(failure);
    docker.calls.length = 0;

    await expect(backend.destroy(prepared.envId!)).rejects.toBe(failure);

    expect(docker.calls.some(args => args[0] === 'rm')).toBe(true);
    expect(docker.calls.some(args => args[0] === 'volume' && args[1] === 'rm')).toBe(true);
    expect(store.rows.get(prepared.envId!)?.status).toBe('active');
  });

  test('is a no-op warning when the env row is missing (idempotent)', async () => {
    const store = fakeStore();
    const docker = fakeDocker(() => ({ stdout: '', stderr: '' }));
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await backend.destroy('missing-env'); // must not throw
    expect(docker.calls.length).toBe(0);
  });

  test('treats "no such container" as idempotent-OK (marks destroyed, no throw)', async () => {
    const store = fakeStore();
    const docker = fakeDocker(args => {
      if (args[0] === 'run') return { stdout: 'cid\n', stderr: '' };
      if (args[0] === 'rm') throw new Error('Error: No such container: archon-x');
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });
    await backend.destroy(prepared.envId as string); // already gone → must not throw
    expect(store.rows.get(prepared.envId as string)?.status).toBe('destroyed');
  });

  test.each(['container', 'volume'])(
    'a misleading not-found error cannot hide a surviving %s',
    async resource => {
      const store = fakeStore();
      const docker = fakeDocker(args => {
        if (args[0] === 'run') return { stdout: 'cid\n', stderr: '' };
        if (args[0] === 'container' && args[1] === 'ls')
          return {
            stdout: `cid\t${String(store.created?.metadata?.containerName)}\trunning`,
            stderr: '',
          };
        if (args[0] === 'volume' && args[1] === 'ls')
          return { stdout: String(store.created?.metadata?.volume), stderr: '' };
        if (
          (resource === 'container' && args[0] === 'rm') ||
          (resource === 'volume' && args[0] === 'volume' && args[1] === 'rm')
        )
          throw new Error(`No such ${resource}: timeout permission denied`);
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      const prepared = await backend.prepare({ codebase: FOLDER });
      await expect(backend.destroy(prepared.envId!)).rejects.toThrow(`No such ${resource}`);
      expect(store.rows.get(prepared.envId!)?.status).toBe('active');
    }
  );

  test('THROWS and leaves the row active on a GENUINE docker rm failure', async () => {
    const store = fakeStore();
    const docker = fakeDocker(args => {
      if (args[0] === 'run') return { stdout: 'cid\n', stderr: '' };
      if (args[0] === 'container')
        return {
          stdout: `cid\t${String(store.created?.metadata?.containerName)}\trunning`,
          stderr: '',
        };
      if (args[0] === 'rm') {
        const err = new Error('rm failed') as Error & { stderr?: string };
        err.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
        throw err;
      }
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });
    // Real failure → surfaced (not swallowed), and the row is NOT marked destroyed
    // so a later cleanup/resume can retry.
    await expect(backend.destroy(prepared.envId as string)).rejects.toThrow(
      /Failed to remove the isolation container/
    );
    expect(store.rows.get(prepared.envId as string)?.status).toBe('active');
  });

  // The SQLite-vs-Postgres metadata-shape mismatch (SQLite returns a JSON STRING,
  // Postgres a parsed object) once made destroy() skip `docker rm` and leak the
  // container. That dialect normalization now lives at the store boundary
  // (normalizeEnvironmentRow in db/isolation-environments.ts, covered by its own
  // test), so the backend trusts a parsed-object `metadata` — the tests below seed
  // objects exactly as the store hands them back.

  test('throws (not silently no-ops) when metadata has no containerName/volume', async () => {
    const store = fakeStore();
    const docker = fakeDocker(() => ({ stdout: '', stderr: '' }));
    const row = await store.create({
      codebase_id: FOLDER.id,
      workflow_type: 'task',
      workflow_id: 'empty-meta',
      provider: 'container',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
      metadata: {},
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.destroy(row.id)).rejects.toThrow(/no containerName\/volume/);
  });
});

// ---------------------------------------------------------------------------
// Phase C — suspend / resumeEnv / finalize / applyChanges / discardChanges
// ---------------------------------------------------------------------------

/** Seed an active container env row with full metadata (as prepare would leave it). */
function seedContainerRow(
  store: ReturnType<typeof fakeStore>,
  meta?: Partial<Record<string, unknown>>
): IsolationEnvironmentRow {
  const row: IsolationEnvironmentRow = {
    id: 'env-c',
    codebase_id: 'cb-1',
    workflow_type: 'task',
    workflow_id: 'res-1',
    provider: 'container',
    working_path: '/tmp/ops-client',
    branch_name: '' as unknown as IsolationEnvironmentRow['branch_name'],
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'cli',
    created_by_user_id: null,
    metadata: {
      containerId: 'cid-orig',
      containerName: 'archon-res-1',
      volume: 'archon-res-1-upper',
      image: 'archon-runner:test',
      resourceId: 'res-1',
      workspacePath: '/tmp/ops-client',
      overlayMode: 'fuse',
      ...meta,
    },
  };
  store.rows.set(row.id, row);
  return row;
}

describe('ContainerBackend.suspend', () => {
  test('refuses to prepare a stop for a different execution container', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(() => ({ stdout: '', stderr: '' }));
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.prepareSuspend('env-c', 'other-container', 2_000)).rejects.toThrow(
      'does not own execution container'
    );
    expect(docker.calls).toEqual([]);
  });

  test.each(['exec', 'stop', 'container'])(
    'bounds every Docker call when %s fails during a source release',
    async failing => {
      const store = fakeStore();
      seedContainerRow(store, { artifactsMount: '/artifacts' });
      const identity = spyOn(containerModule, 'currentHostIdentity').mockReturnValue({
        uid: 1000,
        gid: 1000,
      });
      const calls: { args: string[]; timeout: number | undefined }[] = [];
      const docker: DockerRunner = async (args, options) => {
        calls.push({ args, timeout: options?.timeout });
        if (args[0] === failing || args[0] === 'stop') throw new Error('Docker timed out');
        return { stdout: 'cid-orig\tarchon-res-1\trunning\n', stderr: '' };
      };
      try {
        const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
        const stop = await backend.prepareSuspend('env-c', 'cid-orig', 2_000);
        await expect(stop()).rejects.toThrow('Failed to suspend');
        expect(calls.map(call => call.args[0])).toEqual(['exec', 'stop', 'container']);
        expect(calls.map(call => call.timeout)).toEqual([2_000, 2_000, 2_000]);
        expect(calls[0]?.args).toEqual([
          'exec',
          'cid-orig',
          'chown',
          '-R',
          '1000:1000',
          '/artifacts',
        ]);
        expect(calls[1]?.args).toEqual(['stop', '--time', '1', 'cid-orig']);
        expect(calls.reduce((total, call) => total + (call.timeout ?? 60_000), 0)).toBeLessThan(
          10_000
        );
      } finally {
        identity.mockRestore();
      }
    }
  );

  test('docker stops the container by name', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(() => ({ stdout: '', stderr: '' }));
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await backend.suspend('env-c');
    const stop = docker.calls.find(c => c[0] === 'stop');
    expect(stop).toEqual(['stop', 'archon-res-1']);
  });

  test('keeps the execution ID across replacement and repeats without store access', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(() => ({ stdout: '', stderr: '' }));
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const read = spyOn(store, 'getById');
    const stop = await backend.prepareSuspend('env-c', 'cid-orig');
    expect(read).toHaveBeenCalledTimes(1);
    expect(docker.calls).toEqual([]);
    await store.updateMetadata('env-c', { containerId: 'cid-replacement' });
    read.mockImplementation(async () => {
      throw new Error('store access inside transition');
    });
    try {
      await stop();
      await stop();
      expect(docker.calls.filter(c => c[0] === 'stop')).toEqual([
        ['stop', 'cid-orig'],
        ['stop', 'cid-orig'],
      ]);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  test('a missing execution container ignores a running replacement under the same name', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(args => {
      if (args[0] === 'container') {
        return { stdout: 'cid-replacement\tarchon-res-1\trunning\n', stderr: '' };
      }
      throw new Error('execution container is gone');
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const stop = await backend.prepareSuspend('env-c', 'cid-orig', 2_000);
    await store.updateMetadata('env-c', { containerId: 'cid-replacement' });
    await expect(stop()).resolves.toBeUndefined();
    expect(docker.calls.find(args => args[0] === 'stop')).toEqual([
      'stop',
      '--time',
      '1',
      'cid-orig',
    ]);
  });

  test('is idempotent when the container is already gone', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(args => {
      if (args[0] === 'container') return { stdout: '', stderr: '' };
      throw new Error('arbitrary vendor wording');
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.suspend('env-c')).resolves.toBeUndefined();
  });

  for (const state of ['paused', 'restarting']) {
    test(`failed stop remains a failure when container is ${state}`, async () => {
      const store = fakeStore();
      seedContainerRow(store);
      const docker = fakeDocker(args => {
        if (args[0] === 'container')
          return { stdout: `cid-orig\tarchon-res-1\t${state}\n`, stderr: '' };
        throw new Error('stop failed');
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      await expect(backend.suspend('env-c')).rejects.toThrow(/Failed to suspend/);
    });
  }

  test('throws on a genuine docker failure (resources still consuming)', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.suspend('env-c')).rejects.toThrow(/Failed to suspend/);
  });
});

describe('ContainerBackend.resumeEnv', () => {
  for (const state of ['running', 'created', 'exited', 'dead', 'removing']) {
    test.each(
      ['bogus', '', null, 1, { toString: null, value: 'broken-mode' }, ['bogus']].map(value => [
        value,
      ])
    )(`rejects invalid persisted overlay mode %j for a ${state} container`, async overlayMode => {
      const store = fakeStore();
      const row = seedContainerRow(store);
      await store.updateMetadata(row.id, { overlayMode });
      const docker = fakeDocker(args => {
        if (args[0] === 'container')
          return { stdout: `cid-orig\tarchon-res-1\t${state}\n`, stderr: '' };
        if (args[0] === 'inspect' && args.includes('{{.Id}}'))
          return { stdout: 'cid-orig\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      const error = await backend.resumeEnv(row.id).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(IsolationFailure);
      if (!(error instanceof IsolationFailure)) throw error;
      expect(error.kind).toBe('unclassified');
      expect(error.message).toContain('invalid persisted overlay mode');
      expect(error.message).toContain(row.id);
      expect(error.message).toContain(JSON.stringify(overlayMode));
      expect(isKnownIsolationError(error)).toBe(false);
      expect(docker.calls.some(args => args[0] === 'start' || args[0] === 'exec')).toBe(false);
    });
  }

  for (const state of ['running', 'created', 'exited', 'dead', 'removing']) {
    test.each([
      ['fuse', ['ARCHON_OVERLAY_MODE=native']],
      ['native', ['ARCHON_OVERLAY_MODE=fuse']],
      ['fuse', []],
      ['fuse', ['ARCHON_OVERLAY_MODE=bogus']],
      ['fuse', ['ARCHON_OVERLAY_MODE=fuse', 'ARCHON_OVERLAY_MODE=native']],
    ])(
      `rejects unverified container mode for a ${state} container (stored: %s, env: %j)`,
      async (mode, environment) => {
        const store = fakeStore();
        seedContainerRow(store, { overlayMode: mode });
        const docker = fakeDocker(args => {
          if (args[0] === 'container')
            return { stdout: `cid-orig\tarchon-res-1\t${state}\n`, stderr: '' };
          if (args[0] === 'inspect' && args.includes('{{.Id}}'))
            return { stdout: 'cid-orig\n', stderr: '' };
          if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
            expect(args.at(-1)).toBe('cid-orig');
            return { stdout: JSON.stringify(environment), stderr: '' };
          }
          return { stdout: '', stderr: '' };
        });
        const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
        const error = await backend.resumeEnv('env-c').catch((error: unknown) => error);
        expect(error).toBeInstanceOf(IsolationFailure);
        if (!(error instanceof IsolationFailure)) throw error;
        expect(error.kind).toBe('unclassified');
        expect(error.message).toContain('env-c');
        expect(error.message).toContain('cid-orig');
        expect(error.message).toContain(`does not match recorded overlay mode '${String(mode)}'`);
        expect(error.message).toContain(JSON.stringify(environment));
        expect(isKnownIsolationError(error)).toBe(false);
        expect(
          docker.calls.some(
            args => args[0] !== undefined && ['start', 'exec', 'run', 'rm'].includes(args[0])
          )
        ).toBe(false);
      }
    );
  }

  test('persists native recreation so successive resumes retain the security mode', async () => {
    const store = fakeStore();
    const row = seedContainerRow(store);
    let runs = 0;
    const docker = fakeDocker(args => {
      if (args[0] === 'container')
        return {
          stdout: runs === 2 ? 'cid-2\tarchon-res-1\trunning\n' : '',
          stderr: '',
        };
      if (args[0] === 'volume') return { stdout: 'archon-res-1-upper\n', stderr: '' };
      if (args[0] === 'run') return { stdout: `cid-${++runs}\n`, stderr: '' };
      if (args[0] === 'exec' && runs === 1) throw new IsolationFailure('unclassified', 'not ready');
      if (args[0] === 'inspect')
        return {
          stdout: args.includes('{{json .Config.Env}}')
            ? JSON.stringify(['ARCHON_OVERLAY_MODE=native'])
            : args.includes('{{.Id}}')
              ? 'cid-2\n'
              : args.includes('{{.State.ExitCode}}')
                ? '78\n'
                : 'false\n',
          stderr: '',
        };
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const recreated = await backend.resumeEnv(row.id);
    expect(recreated.overlayMode).toBe('native');
    const resumed = await backend.resumeEnv(row.id);
    expect(resumed).toEqual(recreated);
    expect(resumed.overlayMode).toBe('native');
    expect(row.metadata).toMatchObject({ containerId: 'cid-2', overlayMode: 'native' });
    expect(runs).toBe(2);
  });

  for (const priorMode of ['fuse', 'native'] as const) {
    for (const state of ['running', 'exited']) {
      test.each([false, true])(
        `failed metadata write after ${priorMode} recreation preserves safe ${state} retry (cleanup fails: %s)`,
        async cleanupFails => {
          const store = fakeStore();
          const row = seedContainerRow(store, { overlayMode: priorMode });
          const persistenceError = new Error('metadata write failed');
          const cleanupError = new Error('container removal failed');
          spyOn(store, 'updateMetadata').mockRejectedValueOnce(persistenceError);
          const mode = priorMode === 'fuse' ? 'native' : 'fuse';
          let containerId: string | undefined;
          let activeMode = 'fuse';
          let runs = 0;
          const docker = fakeDocker(args => {
            if (args[0] === 'container')
              return {
                stdout: containerId ? `${containerId}\tarchon-res-1\t${state}\n` : '',
                stderr: '',
              };
            if (args[0] === 'volume') return { stdout: 'archon-res-1-upper\n', stderr: '' };
            if (args[0] === 'run') {
              activeMode = args.includes('SYS_ADMIN') ? 'native' : 'fuse';
              containerId = `cid-${++runs}`;
              return { stdout: containerId, stderr: '' };
            }
            if (args[0] === 'exec' && mode === 'native' && activeMode === 'fuse')
              throw new IsolationFailure('unclassified', 'not ready');
            if (args[0] === 'inspect')
              return {
                stdout: args.includes('{{json .Config.Env}}')
                  ? JSON.stringify([`ARCHON_OVERLAY_MODE=${activeMode}`])
                  : args.includes('{{.Id}}')
                    ? (containerId ?? '')
                    : args.includes('{{.State.ExitCode}}')
                      ? '78'
                      : 'false',
                stderr: '',
              };
            if (args[0] === 'rm') {
              if (cleanupFails && activeMode === mode) throw cleanupError;
              containerId = undefined;
            }
            return { stdout: '', stderr: '' };
          });
          const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
          const error = await backend.resumeEnv(row.id).catch((error: unknown) => error);
          if (cleanupFails) {
            expect(error).toBeInstanceOf(IsolationFailure);
            if (!(error instanceof IsolationFailure)) throw error;
            expect(isKnownIsolationError(error)).toBe(false);
            expect(error.message).toContain(persistenceError.message);
            expect(error.message).toContain(cleanupError.message);
            expect(error.cause).toBeInstanceOf(AggregateError);
            if (!(error.cause instanceof AggregateError)) throw error;
            expect(error.cause.errors).toEqual([persistenceError, cleanupError]);
            expect(row.metadata).toMatchObject({ containerId: 'cid-orig', overlayMode: priorMode });
            const callsBeforeRetry = docker.calls.length;
            await expect(backend.resumeEnv(row.id)).rejects.toThrow('does not match');
            expect(docker.calls.slice(callsBeforeRetry).map(args => args[0])).toEqual([
              'container',
              'inspect',
            ]);
          } else {
            expect(error).toBe(persistenceError);
            expect(containerId).toBeUndefined();
            const retried = await backend.resumeEnv(row.id);
            expect(retried.overlayMode).toBe(mode);
            expect(row.metadata).toMatchObject({ containerId, overlayMode: mode });
            expect(await backend.resumeEnv(row.id)).toEqual(retried);
          }
          expect(docker.calls.filter(args => args[0] === 'rm')).toContainEqual([
            'rm',
            '-f',
            mode === 'native' ? 'cid-2' : 'cid-1',
          ]);
          expect(docker.calls.some(args => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
        }
      );
    }
  }

  test.each(['paused', 'restarting'])(
    'rejects a %s container before returning an execution handle',
    async state => {
      const store = fakeStore();
      seedContainerRow(store);
      const docker = fakeDocker(args => {
        if (args[0] === 'container')
          return { stdout: `cid-orig\tarchon-res-1\t${state}\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      await expect(backend.resumeEnv('env-c')).rejects.toThrow(
        `container 'archon-res-1' is ${state}`
      );
      expect(docker.calls.map(args => args[0])).toEqual(['container']);
    }
  );

  test.each([...OVERLAY_MODES, undefined])(
    'reuses a still-running container (mode: %s)',
    async mode => {
      const store = fakeStore();
      const row = seedContainerRow(store, { overlayMode: mode });
      if (mode === undefined) delete row.metadata.overlayMode;
      const docker = fakeDocker(args => {
        if (args[0] === 'container' && args[1] === 'ls') {
          return { stdout: 'cid-orig\tarchon-res-1\trunning\n', stderr: '' };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}'))
          return {
            stdout: JSON.stringify(['PATH=/usr/bin', `ARCHON_OVERLAY_MODE=${mode ?? 'native'}`]),
            stderr: '',
          };
        if (args[0] === 'inspect' && args.includes('{{.Id}}'))
          return { stdout: 'cid-orig\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      const prepared = await backend.resumeEnv('env-c');
      expect(prepared.overlayMode).toBe(mode ?? 'native');
      expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-orig' });
      expect(docker.calls.find(c => c[0] === 'start')).toBeUndefined();
    }
  );

  test.each([...OVERLAY_MODES, undefined])(
    'starts a stopped container and waits for the overlay (mode: %s)',
    async mode => {
      const store = fakeStore();
      const row = seedContainerRow(store, { overlayMode: mode });
      if (mode === undefined) delete row.metadata.overlayMode;
      const docker = fakeDocker(args => {
        if (args[0] === 'container' && args[1] === 'ls') {
          return { stdout: 'cid-orig\tarchon-res-1\texited\n', stderr: '' };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}'))
          return {
            stdout: JSON.stringify(['PATH=/usr/bin', `ARCHON_OVERLAY_MODE=${mode ?? 'native'}`]),
            stderr: '',
          };
        if (args[0] === 'inspect' && args.includes('{{.Id}}'))
          return { stdout: 'cid-orig\n', stderr: '' };
        if (args[0] === 'start') return { stdout: '', stderr: '' };
        if (args[0] === 'exec' && args.includes('test')) return { stdout: '', stderr: '' }; // ready
        return { stdout: '', stderr: '' };
      });
      const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
      const prepared = await backend.resumeEnv('env-c');
      expect(prepared.overlayMode).toBe(mode ?? 'native');
      expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-orig' });
      expect(docker.calls.find(c => c[0] === 'start')).toEqual(['start', 'cid-orig']);
    }
  );

  test('recreates the container over the surviving volume when the container is gone', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    let ran = false;
    const docker = fakeDocker(args => {
      if (args[0] === 'container' && args[1] === 'ls') return { stdout: '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'ls')
        return {
          stdout: String(store.created?.metadata?.volume ?? 'archon-res-1-upper'),
          stderr: '',
        }; // volume exists
      if (args[0] === 'run') {
        ran = true;
        return { stdout: 'cid-recreated\n', stderr: '' };
      }
      if (args[0] === 'exec' && args.includes('test')) return { stdout: '', stderr: '' }; // ready
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.resumeEnv('env-c');
    expect(ran).toBe(true);
    expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-recreated' });
  });

  test('recreation records the current image for both write-back helpers', async () => {
    const store = fakeStore();
    const row = seedContainerRow(store);
    const image = 'archon-runner:new';
    const docker = fakeDocker(args => {
      if (args[0] === 'container') return { stdout: '', stderr: '' };
      if (args[0] === 'volume') return { stdout: 'archon-res-1-upper', stderr: '' };
      if (args[0] === 'run' && args.includes('-d')) return { stdout: 'cid-recreated', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({
      store,
      config: { ...CONFIG, image },
      dockerRunner: docker,
    });
    await backend.resumeEnv(row.id);
    expect((await store.getById(row.id))?.metadata?.image).toBe(image);
    await backend.finalize(row.id);
    await backend.applyChanges(row.id);
    const runs = docker.calls.filter(args => args[0] === 'run');
    expect(runs).toHaveLength(3);
    for (const args of runs) {
      expect(args).toContain(image);
      expect(args).not.toContain(CONFIG.image);
    }
  });

  test('preserves a failed volume query during resume without claiming work loss or recreating', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const failure = new Error('Docker daemon unavailable during volume query');
    const docker = fakeDocker(args => {
      if (args[0] === 'volume' && args[1] === 'ls') throw failure;
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const error = await backend.resumeEnv('env-c').catch((error: unknown) => error);
    expect(error).toBe(failure);
    expect(failure.message).not.toContain('changes are lost');
    expect(docker.calls).toEqual([
      ['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.State}}'],
      ['volume', 'ls', '--format', '{{.Name}}'],
    ]);
  });

  test('fails LOUD when both the container and the volume are gone (work lost)', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(args => {
      if (args[0] === 'container' && args[1] === 'ls') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.resumeEnv('env-c')).rejects.toThrow(/un-applied changes are lost/);
  });
});

describe('ContainerBackend.finalize / applyChanges / discardChanges', () => {
  test('finalize requires approval only for a non-empty overlay', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const empty = fakeDocker(() => ({ stdout: '', stderr: '' }));
    const backendEmpty = new ContainerBackend({ store, config: CONFIG, dockerRunner: empty });
    const emptyResult = await backendEmpty.finalize('env-c');
    expect(emptyResult.requiresApproval).toBe(false);
    expect(emptyResult.changeSummary?.totalCount).toBe(0);

    const changed = fakeDocker(() => ({ stdout: 'A\tnew.md\0', stderr: '' }));
    const backendChanged = new ContainerBackend({ store, config: CONFIG, dockerRunner: changed });
    const changedResult = await backendChanged.finalize('env-c');
    expect(changedResult.requiresApproval).toBe(true);
    expect(changedResult.changeSummary?.added).toEqual(['new.md']);
  });

  test('applyChanges returns the written + deleted counts', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(() => ({ stdout: 'W\ta.txt\0D\tb.txt\0', stderr: '' }));
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const summary = await backend.applyChanges('env-c');
    expect(summary.filesApplied).toBe(1);
    expect(summary.filesDeleted).toBe(1);
  });

  test('discardChanges is a no-op that never touches docker', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(() => ({ stdout: '', stderr: '' }));
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await backend.discardChanges('env-c');
    expect(docker.calls.length).toBe(0);
  });
});

describe('ContainerBackend source mount', () => {
  /** A capture path under ARCHON_HOME, shaped the way the engine actually passes it. */
  const SOURCE_MOUNT = join(
    getArchonHome(),
    'workspaces',
    '_folder',
    'ops-client',
    'workflow-source',
    'runs',
    'run-1'
  );

  function readyDocker(): ReturnType<typeof fakeDocker> {
    return fakeDocker(args => {
      if (args[0] === 'version') return { stdout: '28', stderr: '' };
      if (args[0] === 'image') return { stdout: '[]', stderr: '' };
      if (args[0] === 'volume') return { stdout: '', stderr: '' };
      if (args[0] === 'run') return { stdout: 'abc123containerid\n', stderr: '' };
      if (args[0] === 'exec') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
  }

  test('binds the run source read-only at the same absolute path', async () => {
    const store = fakeStore();
    const docker = readyDocker();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });

    await backend.prepare({ codebase: FOLDER, sourceMount: SOURCE_MOUNT });

    const runArgs = docker.calls.find(c => c[0] === 'run');
    // Identical host and container path: one source-roots value has to mean the same
    // thing whether a node runs here or on the host.
    expect(runArgs).toContain(`${SOURCE_MOUNT}:${SOURCE_MOUNT}:ro`);
  });

  test('omits the bind entirely when no source is supplied', async () => {
    const store = fakeStore();
    const docker = readyDocker();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });

    await backend.prepare({ codebase: FOLDER });

    const runArgs = docker.calls.find(c => c[0] === 'run') ?? [];
    expect(runArgs.some(a => a.endsWith(':ro') && a.includes('workflow-source'))).toBe(false);
  });

  test('records the mount so a recreated container can restore it', async () => {
    const store = fakeStore();
    const docker = readyDocker();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });

    await backend.prepare({ codebase: FOLDER, sourceMount: SOURCE_MOUNT });

    expect(store.created?.metadata).toMatchObject({ sourceMount: SOURCE_MOUNT });
  });

  test('re-applies the mount when resume has to recreate the container', async () => {
    // The failure this guards: a recreated container without the mount resolves no named
    // script, at a path the run's own metadata reports as intact.
    const store = fakeStore();
    const docker = readyDocker();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER, sourceMount: SOURCE_MOUNT });

    const resumeDocker = fakeDocker(args => {
      if (args[0] === 'container' && args[1] === 'ls') return { stdout: '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'ls')
        return {
          stdout: String(store.created?.metadata?.volume ?? 'archon-res-1-upper'),
          stderr: '',
        };
      if (args[0] === 'run') return { stdout: 'recreatedid\n', stderr: '' };
      if (args[0] === 'exec') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const resumeBackend = new ContainerBackend({
      store,
      config: CONFIG,
      dockerRunner: resumeDocker,
    });

    await resumeBackend.resumeEnv(prepared.envId!);

    const runArgs = resumeDocker.calls.find(c => c[0] === 'run');
    expect(runArgs).toContain(`${SOURCE_MOUNT}:${SOURCE_MOUNT}:ro`);
  });

  test('refuses a mount outside ARCHON_HOME, before any docker work', async () => {
    const store = fakeStore();
    const docker = readyDocker();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });

    await expect(backend.prepare({ codebase: FOLDER, sourceMount: '/etc' })).rejects.toThrow(
      /outside ARCHON_HOME/
    );
    // Rejected before the volume exists, so nothing leaks.
    expect(docker.calls.some(c => c[0] === 'volume' && c[1] === 'create')).toBe(false);
  });

  test('refuses a relative mount', async () => {
    const store = fakeStore();
    const backend = new ContainerBackend({
      store,
      config: CONFIG,
      dockerRunner: readyDocker(),
    });

    await expect(
      backend.prepare({ codebase: FOLDER, sourceMount: 'relative/capture' })
    ).rejects.toThrow(/absolute path/);
  });

  test('refuses a mount that would shadow the workspace root', async () => {
    const store = fakeStore();
    const backend = new ContainerBackend({
      store,
      config: CONFIG,
      dockerRunner: readyDocker(),
    });

    // A capture nested inside the project would shadow the overlay's lower dir.
    await expect(
      backend.prepare({
        codebase: { ...FOLDER, defaultCwd: getArchonHome() },
        sourceMount: join(getArchonHome(), 'nested', 'workflow-source'),
      })
    ).rejects.toThrow(/overlaps the workspace root/);
  });
});

describe('ContainerBackend artifacts mount', () => {
  const RUN_ROOT = join(getArchonHome(), 'workspaces', '_folder', 'ops-client');
  const ARTIFACTS_MOUNT = join(RUN_ROOT, 'artifacts', 'runs', 'run-1');
  const SOURCE_MOUNT = join(RUN_ROOT, 'workflow-source', 'runs', 'run-1');
  const HOST = { uid: 1000, gid: 1000 };
  let identitySpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    identitySpy?.mockRestore();
    identitySpy = undefined;
  });
  /** Pin the host identity the hand-back targets, independent of this runner's uid. */
  function hostIs(identity: { uid: number; gid: number } | undefined): void {
    identitySpy = spyOn(containerModule, 'currentHostIdentity').mockReturnValue(identity);
  }

  function readyDocker(
    extra?: (args: string[]) => DockerExecResult | undefined
  ): ReturnType<typeof fakeDocker> {
    return fakeDocker(args => {
      const handled = extra?.(args);
      if (handled) return handled;
      if (args[0] === 'version') return { stdout: '28', stderr: '' };
      if (args[0] === 'image') return { stdout: '[]', stderr: '' };
      if (args[0] === 'volume') return { stdout: '', stderr: '' };
      if (args[0] === 'run') return { stdout: 'abc123containerid\n', stderr: '' };
      if (args[0] === 'exec') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
  }

  test('binds the run artifacts read-write at the same absolute path, beside the source', async () => {
    const store = fakeStore();
    const docker = readyDocker();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });

    await backend.prepare({
      codebase: FOLDER,
      sourceMount: SOURCE_MOUNT,
      artifactsMount: ARTIFACTS_MOUNT,
    });

    const runArgs = docker.calls.find(c => c[0] === 'run') ?? [];
    // `$ARTIFACTS_DIR` means one host directory on both sides of the boundary, and a
    // node must be able to write there — no `:ro`.
    expect(runArgs).toContain(`${ARTIFACTS_MOUNT}:${ARTIFACTS_MOUNT}`);
    expect(runArgs).not.toContain(`${ARTIFACTS_MOUNT}:${ARTIFACTS_MOUNT}:ro`);
    expect(runArgs).toContain(`${SOURCE_MOUNT}:${SOURCE_MOUNT}:ro`);
  });

  test('records the mount so a recreated container can restore it', async () => {
    const store = fakeStore();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: readyDocker() });

    await backend.prepare({ codebase: FOLDER, artifactsMount: ARTIFACTS_MOUNT });

    expect(store.created?.metadata).toMatchObject({ artifactsMount: ARTIFACTS_MOUNT });
  });

  test('re-applies the mount when resume has to recreate the container', async () => {
    // The failure this guards: a recreated container without the bind writes artifacts
    // into a container-local directory the host engine and operator never see.
    const store = fakeStore();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: readyDocker() });
    const prepared = await backend.prepare({ codebase: FOLDER, artifactsMount: ARTIFACTS_MOUNT });

    const resumeDocker = fakeDocker(args => {
      if (args[0] === 'container' && args[1] === 'ls') return { stdout: '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'ls')
        return {
          stdout: String(store.created?.metadata?.volume ?? 'archon-res-1-upper'),
          stderr: '',
        };
      if (args[0] === 'run') return { stdout: 'recreatedid\n', stderr: '' };
      if (args[0] === 'exec') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const resumeBackend = new ContainerBackend({
      store,
      config: CONFIG,
      dockerRunner: resumeDocker,
    });

    await resumeBackend.resumeEnv(prepared.envId!);

    const runArgs = resumeDocker.calls.find(c => c[0] === 'run');
    expect(runArgs).toContain(`${ARTIFACTS_MOUNT}:${ARTIFACTS_MOUNT}`);
  });

  test('refuses a mount outside ARCHON_HOME, before any docker work', async () => {
    const store = fakeStore();
    const docker = readyDocker();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });

    await expect(
      backend.prepare({ codebase: FOLDER, artifactsMount: '/var/tmp/artifacts' })
    ).rejects.toThrow(/artifacts mount .* outside ARCHON_HOME/);
    expect(docker.calls.some(c => c[0] === 'volume' && c[1] === 'create')).toBe(false);
  });

  test('hands artifacts back to the host user before suspending', async () => {
    // In-container work runs as root. On a rootful Linux daemon that leaves root-owned
    // files under ~/.archon the operator cannot remove; the hand-back runs while the
    // container can still execute it, i.e. before `docker stop`.
    const store = fakeStore();
    const docker = readyDocker();
    hostIs(HOST);
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER, artifactsMount: ARTIFACTS_MOUNT });

    await backend.suspend(prepared.envId!);

    const chown = docker.calls.findIndex(c => c[0] === 'exec' && c.includes('chown'));
    const stop = docker.calls.findIndex(c => c[0] === 'stop');
    expect(chown).toBeGreaterThan(-1);
    expect(docker.calls[chown]).toEqual([
      'exec',
      expect.any(String),
      'chown',
      '-R',
      '1000:1000',
      ARTIFACTS_MOUNT,
    ]);
    expect(chown).toBeLessThan(stop);
  });

  test('hands artifacts back before destroying, without gating on container state', async () => {
    // A pre-check that cannot read the state (`inspect` fails on a flaky daemon) must not
    // skip the hand-back silently; the helper reports a stopped container itself.
    const store = fakeStore();
    const docker = readyDocker(args => {
      if (args[0] === 'inspect') throw new Error('Error response from daemon: timeout');
      return undefined;
    });
    hostIs(HOST);
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER, artifactsMount: ARTIFACTS_MOUNT });

    await backend.destroy(prepared.envId!);

    const chown = docker.calls.findIndex(c => c[0] === 'exec' && c.includes('chown'));
    const rm = docker.calls.findIndex(c => c[0] === 'rm');
    expect(chown).toBeGreaterThan(-1);
    expect(chown).toBeLessThan(rm);
  });

  test.skipIf(process.platform === 'win32')(
    "removes the run's scratch only after the container, keeping its evidence",
    async () => {
      const scratch = join(getRunScratchDir(ARTIFACTS_MOUNT), 'bisect', 'node_modules');
      const report = join(ARTIFACTS_MOUNT, 'report.md');
      mkdirSync(scratch, { recursive: true });
      writeFileSync(report, 'evidence');
      let scratchAtRm: boolean | undefined;
      const docker = readyDocker(args => {
        if (args[0] === 'rm') scratchAtRm = existsSync(scratch);
        return undefined;
      });
      try {
        const store = fakeStore();
        const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
        const prepared = await backend.prepare({
          codebase: FOLDER,
          artifactsMount: ARTIFACTS_MOUNT,
        });

        await backend.destroy(prepared.envId!);

        expect(scratchAtRm).toBe(true);
        expect(existsSync(scratch)).toBe(false);
        expect(readFileSync(report, 'utf8')).toBe('evidence');
      } finally {
        await removeTempTree(ARTIFACTS_MOUNT);
      }
    }
  );

  test('skips the hand-back when the host user is root', async () => {
    const store = fakeStore();
    const docker = readyDocker();
    hostIs({ uid: 0, gid: 0 });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER, artifactsMount: ARTIFACTS_MOUNT });

    await backend.suspend(prepared.envId!);

    expect(docker.calls.some(c => c[0] === 'exec' && c.includes('chown'))).toBe(false);
    expect(docker.calls.some(c => c[0] === 'stop')).toBe(true);
  });

  test('recreating a container from a row without an artifacts mount keeps the source bind only', async () => {
    // A row written before the artifacts bind existed carries only `sourceMount`. The run
    // resumes as it always did, with `$ARTIFACTS_DIR` writes staying in the container, and
    // the backend says so in its log rather than refusing a run that was fine before.
    const store = fakeStore();
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: readyDocker() });
    const prepared = await backend.prepare({ codebase: FOLDER, sourceMount: SOURCE_MOUNT });

    const resumeDocker = fakeDocker(args => {
      if (args[0] === 'container' && args[1] === 'ls') return { stdout: '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'ls')
        return {
          stdout: String(store.created?.metadata?.volume ?? 'archon-res-1-upper'),
          stderr: '',
        };
      if (args[0] === 'run') return { stdout: 'recreatedid\n', stderr: '' };
      if (args[0] === 'exec') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const resumeBackend = new ContainerBackend({
      store,
      config: CONFIG,
      dockerRunner: resumeDocker,
    });

    await expect(resumeBackend.resumeEnv(prepared.envId!)).resolves.toBeDefined();

    const runArgs = resumeDocker.calls.find(c => c[0] === 'run') ?? [];
    expect(runArgs).toContain(`${SOURCE_MOUNT}:${SOURCE_MOUNT}:ro`);
    expect(runArgs.some(a => a.startsWith(`${ARTIFACTS_MOUNT}:`))).toBe(false);
  });

  test('a failed hand-back is logged, not fatal', async () => {
    const store = fakeStore();
    const docker = readyDocker(args => {
      if (args[0] === 'exec' && args.includes('chown')) {
        throw new Error('chown: Operation not permitted');
      }
      return undefined;
    });
    hostIs(HOST);
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER, artifactsMount: ARTIFACTS_MOUNT });

    await expect(backend.suspend(prepared.envId!)).resolves.toBeUndefined();
    expect(docker.calls.some(c => c[0] === 'stop')).toBe(true);
  });
});
