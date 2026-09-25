import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'path';
import { getArchonHome } from '@archon/paths';
import { ContainerBackend } from './container';
import * as containerModule from './container';
import type { ContainerBackendConfig } from '../types';
import type { IIsolationStore } from '../store';
import type { IsolationEnvironmentRow, CreateEnvironmentParams } from '../types';
import type { DockerRunner, DockerExecResult } from '../container/docker-exec';

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
    async updateStatus(id, status) {
      const row = rows.get(id);
      if (row) row.status = status;
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

describe('ContainerBackend.prepare', () => {
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

  test('falls back to native mode (CAP_SYS_ADMIN) when fuse never becomes ready', async () => {
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
        if (runCount === 1) throw new Error('not ready');
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'inspect') return { stdout: 'false\n', stderr: '' }; // fuse exited
      if (args[0] === 'rm') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
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
  });

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
        if (readyChecks < 2) throw new Error('sentinel not present yet');
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
      if (args[0] === 'run') throw new Error('docker: some run failure');
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
        if (readyChecks < 2) throw new Error('sentinel not present yet');
        return { stdout: '', stderr: '' };
      }
      // Inspect ERRORS (transient) → must be treated as 'unknown', NOT 'stopped',
      // so the poll continues on the SAME (fuse) container instead of falling back.
      if (args[0] === 'inspect') throw new Error('Cannot connect to the Docker daemon');
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });
    // Only ONE run — fuse succeeded; the inspect blip did NOT escalate to native.
    expect(runCount).toBe(1);
    expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-1' });
    expect((store.created?.metadata as { overlayMode: string }).overlayMode).toBe('fuse');
  });

  test('falls back to native when the fuse run itself fails (host has no /dev/fuse)', async () => {
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
          throw err;
        }
        return { stdout: 'cid-nofuse\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.prepare({ codebase: FOLDER });
    expect(runAttempts).toBe(2);
    expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-nofuse' });
    expect((store.created?.metadata as { overlayMode: string }).overlayMode).toBe('native');
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

  test('THROWS and leaves the row active on a GENUINE docker rm failure', async () => {
    const store = fakeStore();
    const docker = fakeDocker(args => {
      if (args[0] === 'run') return { stdout: 'cid\n', stderr: '' };
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
  test('docker stops the container by name', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(() => ({ stdout: '', stderr: '' }));
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await backend.suspend('env-c');
    const stop = docker.calls.find(c => c[0] === 'stop');
    expect(stop).toEqual(['stop', 'archon-res-1']);
  });

  test('is idempotent when the container is already gone', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(() => {
      throw new Error('Error: No such container: archon-res-1');
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    await expect(backend.suspend('env-c')).resolves.toBeUndefined();
  });

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
  test('reuses a still-running container', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(args => {
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        return { stdout: 'true\n', stderr: '' };
      }
      if (args[0] === 'inspect' && args.includes('{{.Id}}'))
        return { stdout: 'cid-run\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.resumeEnv('env-c');
    expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-run' });
    expect(docker.calls.find(c => c[0] === 'start')).toBeUndefined();
  });

  test('starts a stopped container and waits for the overlay', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(args => {
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        return { stdout: 'false\n', stderr: '' };
      }
      if (args[0] === 'inspect' && args.includes('{{.Id}}'))
        return { stdout: 'cid-started\n', stderr: '' };
      if (args[0] === 'start') return { stdout: '', stderr: '' };
      if (args[0] === 'exec' && args.includes('test')) return { stdout: '', stderr: '' }; // ready
      return { stdout: '', stderr: '' };
    });
    const backend = new ContainerBackend({ store, config: CONFIG, dockerRunner: docker });
    const prepared = await backend.resumeEnv('env-c');
    expect(prepared.execContext).toEqual({ kind: 'container', containerId: 'cid-started' });
    expect(docker.calls.find(c => c[0] === 'start')).toEqual(['start', 'archon-res-1']);
  });

  test('recreates the container over the surviving volume when the container is gone', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    let ran = false;
    const docker = fakeDocker(args => {
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        throw new Error('Error: No such object: archon-res-1');
      }
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: '[]', stderr: '' }; // volume exists
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

  test('fails LOUD when both the container and the volume are gone (work lost)', async () => {
    const store = fakeStore();
    seedContainerRow(store);
    const docker = fakeDocker(args => {
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        throw new Error('Error: No such object: archon-res-1');
      }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        throw new Error('Error: No such volume: archon-res-1-upper');
      }
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
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        throw new Error('Error: No such object: archon-res-1'); // container gone
      }
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: '[]', stderr: '' };
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
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        throw new Error('Error: No such object: archon-res-1'); // container gone
      }
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: '[]', stderr: '' };
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
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        throw new Error('Error: No such object: archon-res-1'); // container gone
      }
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: '[]', stderr: '' };
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
