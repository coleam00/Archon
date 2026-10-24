import { resolveBashPath } from '@archon/git';
import { OVERLAY_MODES } from '@archon/workflows/container-context';
import { describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { IsolationFailure, isKnownIsolationError } from '../../errors';
import { ContainerBackend } from '../container';
import { CONFIG, FOLDER, fakeDocker, fakeStore } from './container-fixtures';

export function registerOverlayTests() {
  describe('runner overlay modes', () => {
    test.each([...OVERLAY_MODES, 'unsupported'])('accepts only host modes: %s', mode => {
      const entrypoint = readFileSync(
        new URL('../../../docker/entrypoint.sh', import.meta.url),
        'utf8'
      );
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
}

export function registerPrepareTests() {
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
          const error = await backend
            .prepare({ codebase: FOLDER })
            .catch((error: unknown) => error);
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
        await expect(backend.prepare({ codebase: FOLDER })).rejects.toBeInstanceOf(
          IsolationFailure
        );
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
          new URL('../../../docker/entrypoint.sh', import.meta.url),
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
      const meta = store.created?.metadata as {
        containerId: string;
        volume: string;
        image: string;
      };
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
          if (readyChecks < 2)
            throw new IsolationFailure('unclassified', 'sentinel not present yet');
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
        if (args[0] === 'run')
          throw new IsolationFailure('unclassified', 'docker: some run failure');
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
          if (readyChecks < 2)
            throw new IsolationFailure('unclassified', 'sentinel not present yet');
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
}
