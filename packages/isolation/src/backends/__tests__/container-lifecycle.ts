import { OVERLAY_MODES } from '@archon/workflows/container-context';
import { describe, expect, spyOn, test } from 'bun:test';
import type { DockerRunner } from '../../container/docker-exec';
import { IsolationFailure, isKnownIsolationError } from '../../errors';
import * as containerModule from '../container';
import { ContainerBackend } from '../container';
import { CONFIG, FOLDER, fakeDocker, fakeStore, seedContainerRow } from './container-fixtures';

export function registerDestroyTests() {
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
}

export function registerSuspendTests() {
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
}

export function registerResumeTests() {
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
      function inspectOutput(args: string[]): string {
        return args.includes('{{json .Config.Env}}')
          ? JSON.stringify(['ARCHON_OVERLAY_MODE=native'])
          : args.includes('{{.Id}}')
            ? 'cid-2\n'
            : args.includes('{{.State.ExitCode}}')
              ? '78\n'
              : 'false\n';
      }
      const docker = fakeDocker(args => {
        if (args[0] === 'container')
          return {
            stdout: runs === 2 ? 'cid-2\tarchon-res-1\trunning\n' : '',
            stderr: '',
          };
        if (args[0] === 'volume') return { stdout: 'archon-res-1-upper\n', stderr: '' };
        if (args[0] === 'run') return { stdout: `cid-${++runs}\n`, stderr: '' };
        if (args[0] === 'exec' && runs === 1)
          throw new IsolationFailure('unclassified', 'not ready');
        if (args[0] === 'inspect')
          return {
            stdout: inspectOutput(args),
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
            function inspectOutput(args: string[]): string {
              return args.includes('{{json .Config.Env}}')
                ? JSON.stringify([`ARCHON_OVERLAY_MODE=${activeMode}`])
                : args.includes('{{.Id}}')
                  ? (containerId ?? '')
                  : args.includes('{{.State.ExitCode}}')
                    ? '78'
                    : 'false';
            }
            function removeContainer(): void {
              if (cleanupFails && activeMode === mode) throw cleanupError;
              containerId = undefined;
            }
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
                  stdout: inspectOutput(args),
                  stderr: '',
                };
              if (args[0] === 'rm') {
                removeContainer();
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
              expect(row.metadata).toMatchObject({
                containerId: 'cid-orig',
                overlayMode: priorMode,
              });
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
        if (args[0] === 'run' && args.includes('-d'))
          return { stdout: 'cid-recreated', stderr: '' };
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
}

export function registerFinalizeTests() {
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
}
