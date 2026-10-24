import { getArchonHome, getRunScratchDir } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import type { DockerExecResult } from '../../container/docker-exec';
import * as containerModule from '../container';
import { ContainerBackend } from '../container';
import { CONFIG, FOLDER, fakeDocker, fakeStore } from './container-fixtures';

export function registerSourceMountTests() {
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
}

export function registerArtifactsMountTests() {
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

    test("removes the run's scratch only after the container, keeping its evidence", async () => {
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
    });

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
}
