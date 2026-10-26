// @archon-test-isolated
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { getArchonHome, getRunArtifactsDirForRoot } from '@archon/paths/archon-paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { writeNodeArtifact } from './artifacts-index';
import { observeArtifactManifest } from './terminal-artifact-manifest';
import {
  buildRunNodeStates,
  buildTerminalRecord,
  getTerminalRecord,
  terminalArtifactsFor,
  type TerminalRecordEvent,
} from './terminal-record';
import { fanOutOutcome } from './schemas/fan-out-outcome';
import {
  type ArtifactManifest,
  RUN_GRAPH_METADATA_KEY,
  WORKTREE_DISPOSITION_METADATA_KEY,
} from './schemas/terminal-record';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempTree(root);
});
async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'terminal-record-')));
  roots.push(root);
  return root;
}
const run = {
  id: 'run-1',
  status: 'failed' as const,
  outcome: null,
  output_root: null,
  checkout_baseline: null,
  metadata: {
    [RUN_GRAPH_METADATA_KEY]: {
      node_ids: ['discover', 'build', 'report', 'untouched'],
      returns: 'discover',
    },
  },
};
function node(
  event_type: string,
  step_name: string,
  data: Record<string, unknown> = {}
): TerminalRecordEvent {
  return { event_type, step_name, data };
}

describe('terminal artifact observation', () => {
  it('retains plain discoveries and typed ownership using the actual file size', async () => {
    const root = await scratch();
    await mkdir(join(root, 'discoveries'));
    await writeFile(join(root, 'discoveries', 'finding.md'), 'discovery');
    const metadata = await writeNodeArtifact(
      root,
      {
        nodeId: 'review',
        outputType: 'findings',
        runId: 'run-1',
        producedAt: '2026-09-09T12:00:00.000Z',
      },
      'first'
    );
    await writeFile(join(root, metadata.path), 'updated content');
    const manifest = await observeArtifactManifest(root);
    expect(manifest.limitations).toEqual([]);
    expect(manifest.files).toContainEqual({ path: 'discoveries/finding.md', size: 9 });
    expect(manifest.files).toContainEqual({
      path: metadata.path.split(sep).join('/'),
      size: 15,
      metadata,
    });
  });

  it('exposes missing roots, corrupt or orphan metadata, and excluded file and directory links', async () => {
    const root = await scratch();
    const outside = await scratch();
    await mkdir(join(root, 'nodes'));
    await writeFile(join(outside, 'secret.md'), 'must not be read');
    await symlink(join(outside, 'secret.md'), join(root, 'linked.md'));
    await symlink(outside, join(root, 'linked-directory'));
    await symlink(join(outside, 'secret.md'), join(root, 'nodes', 'linked.meta.json'));
    await writeFile(join(root, 'nodes', 'bad.meta.json'), '{broken');
    await writeNodeArtifact(
      root,
      {
        nodeId: 'missing',
        outputType: 'findings',
        runId: 'run-1',
        producedAt: '2026-09-09T12:00:00.000Z',
      },
      'deleted'
    );
    await removeTempTree(join(root, 'nodes', 'missing.md'));
    const manifest = await observeArtifactManifest(root);
    expect(manifest.limitations).toEqual(
      expect.arrayContaining([
        { path: 'linked.md', kind: 'link_excluded' },
        { path: 'linked-directory', kind: 'link_excluded' },
        { path: 'nodes/linked.meta.json', kind: 'link_excluded' },
        { path: 'nodes/bad.meta.json', kind: 'invalid_metadata' },
        { path: 'nodes/missing.meta.json', kind: 'invalid_metadata' },
      ])
    );
    expect(manifest.files.map(file => file.path)).toEqual([
      'nodes/bad.meta.json',
      'nodes/missing.meta.json',
    ]);
    expect((await observeArtifactManifest(join(root, 'absent'))).limitations).toEqual([
      { path: '', kind: 'missing', code: 'ENOENT' },
    ]);
    expect((await observeArtifactManifest(null)).limitations).toEqual([
      { path: '', kind: 'root_unavailable' },
    ]);
    expect((await observeArtifactManifest(join(root, 'linked-directory'))).limitations).toEqual([
      { path: '', kind: 'link_excluded' },
    ]);
  });

  it('accepts storage aliases while excluding links below storage and rejecting foreign sidecars', async () => {
    const base = await scratch();
    const storage = join(base, 'storage');
    const alias = join(base, 'alias');
    const root = join(storage, 'artifacts', 'runs', 'run-1');
    await mkdir(root, { recursive: true });
    await symlink(storage, alias);
    await writeNodeArtifact(
      root,
      {
        nodeId: 'foreign',
        outputType: 'findings',
        runId: 'other-run',
        producedAt: '2026-09-09T12:00:00.000Z',
      },
      'foreign'
    );
    const manifest = await observeArtifactManifest(
      join(alias, 'artifacts', 'runs', 'run-1'),
      alias,
      'run-1'
    );
    expect(manifest.files).toContainEqual({ path: 'nodes/foreign.md', size: 7 });
    expect(manifest.limitations).toEqual([
      { path: 'nodes/foreign.meta.json', kind: 'invalid_metadata' },
    ]);
    await symlink(root, join(storage, 'linked-run'));
    expect((await observeArtifactManifest(join(alias, 'linked-run'), alias)).limitations).toEqual([
      { path: '', kind: 'link_excluded' },
    ]);
  });

  it.each(['link', 'replacement'] as const)(
    'rejects a sidecar %s between observation and open',
    async replacement => {
      const root = await scratch();
      const outside = await scratch();
      await mkdir(join(root, 'nodes'));
      const sidecar = join(root, 'nodes', 'swapped.meta.json');
      await writeFile(sidecar, '{}');
      const external = join(outside, 'secret');
      await writeFile(external, 'external contents');
      const realOpen = fsPromises.open;
      const intercepted = spyOn(fsPromises, 'open').mockImplementation(
        async (path, flags, mode) => {
          if (path === sidecar) {
            if (replacement === 'link') {
              await removeTempTree(sidecar);
              await symlink(external, sidecar);
            } else {
              await rename(external, sidecar);
            }
          }
          return realOpen(path, flags, mode);
        }
      );
      try {
        const manifest = await observeArtifactManifest(root);
        expect(manifest.limitations).toEqual([
          expect.objectContaining({ path: 'nodes/swapped.meta.json', kind: 'unreadable' }),
        ]);
        expect(manifest.files.every(file => file.metadata === undefined)).toBe(true);
      } finally {
        intercepted.mockRestore();
      }
    }
  );

  it.each(['dev', 'ino'] as const)(
    'does not read a replaced sidecar when distinct %s IDs round to the same number',
    async field => {
      const root = await scratch();
      const outside = await scratch();
      await mkdir(join(root, 'nodes'));
      const sidecar = join(root, 'nodes', 'swapped.meta.json');
      const external = join(outside, 'secret');
      await writeFile(sidecar, '{}');
      await writeFile(external, 'external contents');
      const observedId = 2n ** 54n;
      const replacementId = observedId + 1n;
      expect(Number(observedId)).toBe(Number(replacementId));

      const realLstat = fsPromises.lstat;
      const realOpen = fsPromises.open;
      let externalReads = 0;
      let observedSidecar = false;
      // Proxies retain the native overloads while changing only fixture identities.
      const statSpy = spyOn(fsPromises, 'lstat').mockImplementation(
        new Proxy(realLstat, {
          async apply(
            target,
            _receiver,
            args: Parameters<typeof realLstat>
          ): ReturnType<typeof realLstat> {
            const [path] = args;
            const stat = await target(...args);
            if (path === sidecar) {
              observedSidecar = true;
              Object.assign(stat, {
                dev: typeof stat.dev === 'bigint' ? 1n : 1,
                ino: typeof stat.ino === 'bigint' ? 1n : 1,
                [field]: typeof stat[field] === 'bigint' ? observedId : Number(observedId),
              });
            }
            return stat;
          },
        })
      );
      const openSpy = spyOn(fsPromises, 'open').mockImplementation(async (path, flags, mode) => {
        if (path !== sidecar) return realOpen(path, flags, mode);
        // Model an open following a replaced path when O_NOFOLLOW is unavailable.
        const handle = await realOpen(external, 'r');
        const realStat = handle.stat.bind(handle);
        spyOn(handle, 'stat').mockImplementation(
          new Proxy(realStat, {
            async apply(
              target,
              _receiver,
              args: Parameters<typeof realStat>
            ): ReturnType<typeof realStat> {
              const stat = await target(...args);
              return Object.assign(stat, {
                dev: typeof stat.dev === 'bigint' ? 1n : 1,
                ino: typeof stat.ino === 'bigint' ? 1n : 1,
                [field]: typeof stat[field] === 'bigint' ? replacementId : Number(replacementId),
              });
            },
          })
        );
        spyOn(handle, 'readFile').mockImplementation(async () => {
          externalReads++;
          throw new Error('Must not read the replaced sidecar');
        });
        return handle;
      });
      try {
        const manifest = await observeArtifactManifest(root);
        expect(observedSidecar).toBe(true);
        expect(externalReads).toBe(0);
        expect(manifest.limitations).toEqual([
          { path: 'nodes/swapped.meta.json', kind: 'unreadable', code: 'ESTALE' },
        ]);
      } finally {
        statSpy.mockRestore();
        openSpy.mockRestore();
      }
    }
  );

  it('distinguishes an unreadable directory listing from an empty inventory', async () => {
    const root = await scratch();
    const file = join(root, 'file');
    await writeFile(file, 'contents');
    expect((await observeArtifactManifest(file)).limitations).toEqual([
      { path: '', kind: 'unreadable', code: 'ENOTDIR' },
    ]);
  });

  it('does not walk node_modules or .git directories and records each as excluded', async () => {
    const root = await scratch();
    await writeFile(join(root, 'report.md'), 'report');
    await mkdir(join(root, 'evidence', 'app', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'evidence', 'app', 'node_modules', 'pkg', 'index.js'), '');
    await mkdir(join(root, 'evidence', 'app', '.git'), { recursive: true });
    await writeFile(join(root, 'evidence', 'app', '.git', 'HEAD'), 'ref');
    const readdirSpy = spyOn(fsPromises, 'readdir');
    try {
      const manifest = await observeArtifactManifest(root);
      expect(manifest.files.map(file => file.path)).toEqual(['report.md']);
      expect(manifest.limitations).toEqual([
        { path: 'evidence/app/.git', kind: 'unsupported_entry', code: 'excluded_directory' },
        {
          path: 'evidence/app/node_modules',
          kind: 'unsupported_entry',
          code: 'excluded_directory',
        },
      ]);
      const walked = readdirSpy.mock.calls.map(([path]) => String(path));
      expect(walked).toContain(join(root, 'evidence', 'app'));
      expect(walked.some(path => /node_modules|\.git/.test(path))).toBe(false);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('stops at the entry limit and records the first entry it did not list', async () => {
    const root = await scratch();
    for (const name of ['a', 'b', 'c', 'd', 'e']) await writeFile(join(root, name), name);
    const manifest = await observeArtifactManifest(root, undefined, undefined, 3);
    expect(manifest.files.map(file => file.path)).toEqual(['a', 'b', 'c']);
    expect(manifest.limitations).toEqual([
      { path: 'd', kind: 'unsupported_entry', code: 'entry_limit' },
    ]);
  });

  it('stops the whole walk when the limit is reached inside a directory', async () => {
    const root = await scratch();
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    for (const name of ['1', '2', '3']) await writeFile(join(root, 'a', name), name);
    await writeFile(join(root, 'b', 'later'), 'later');
    const manifest = await observeArtifactManifest(root, undefined, undefined, 2);
    expect(manifest.files.map(file => file.path)).toEqual(['a/1', 'a/2']);
    expect(manifest.limitations).toEqual([
      { path: 'a/3', kind: 'unsupported_entry', code: 'entry_limit' },
    ]);
  });

  it('records a terminal write that missed its walk as not observed', () => {
    const outputRoot = join(getArchonHome(), 'workspaces', 'owner', 'repo');
    const rooted = { id: 'run-1', output_root: outputRoot };
    const root = getRunArtifactsDirForRoot(outputRoot, 'run-1');
    const observed = { root, files: [], limitations: [] };
    expect(terminalArtifactsFor(rooted, observed)).toBe(observed);
    const notObserved = (root: string | null): ArtifactManifest => ({
      root,
      files: [],
      limitations: [{ path: '', kind: 'root_unavailable', code: 'not_observed' }],
    });
    expect(terminalArtifactsFor(rooted, undefined)).toEqual(notObserved(root));
    expect(terminalArtifactsFor(rooted, { ...observed, root: null })).toEqual(notObserved(root));
    expect(terminalArtifactsFor({ id: 'run-1', output_root: null }, observed)).toEqual(
      notObserved(null)
    );
  });
});

// Every run here has no storage root, so its observed manifest is fixed.
const unrooted = {
  root: null,
  files: [],
  limitations: [{ path: '', kind: 'root_unavailable' as const }],
};
function fold(
  input: Omit<Parameters<typeof buildTerminalRecord>[0], 'artifacts'>
): ReturnType<typeof buildTerminalRecord> {
  return buildTerminalRecord({ ...input, artifacts: unrooted });
}

describe('durable terminal projection', () => {
  it('preserves structured return values, failure cascades, and unstarted nodes without a report node', async () => {
    const record = fold({
      run: { ...run, metadata: { ...run.metadata, error: 'build failed' } },
      events: [
        node('node_completed', 'discover', {
          node_output: 'text wrapper',
          structured_output: { findings: ['one'] },
        }),
        node('node_failed', 'build', { error: 'compiler failed' }),
        node('node_skipped', 'report', {
          reason: 'trigger_rule',
          cause: { kind: 'upstream_failed', origin: 'build' },
        }),
      ],
    });
    expect(record.error).toBe('build failed');
    expect(record.first_failed_node).toBe('build');
    expect(record.outcome).toBeNull();
    expect(record.nodes).toEqual([
      { node_id: 'discover', state: 'completed' },
      { node_id: 'build', state: 'failed', error: 'compiler failed' },
      {
        node_id: 'report',
        state: 'skipped',
        reason: 'trigger_rule',
        cause: { kind: 'upstream_failed', origin: 'build' },
      },
      { node_id: 'untouched', state: 'pending' },
    ]);
    expect(record.returns).toEqual({
      availability: 'available',
      node_id: 'discover',
      value: { findings: ['one'] },
    });
    const events = [
      { event_type: 'workflow_failed', data: JSON.stringify({ terminal_record: record }) },
    ];
    expect(getTerminalRecord('failed', events)).toEqual(record);
    expect(getTerminalRecord('running', events)).toBeNull();
    expect(
      getTerminalRecord('failed', [...events, { event_type: 'workflow_failed', data: '{}' }])
    ).toBeNull();
  });

  it('selects the first surviving failure by event order rather than graph order', async () => {
    const record = fold({
      run,
      events: [
        node('node_failed', 'build', { error: 'earlier failure' }),
        node('node_failed', 'discover', { error: 'later failure' }),
      ],
    });
    expect(record.first_failed_node).toBe('build');
    expect(record.nodes.filter(node => node.state === 'failed').map(node => node.node_id)).toEqual([
      'discover',
      'build',
    ]);
  });

  it('replay replaces stale success/failure and cancellation truthfully retains running states', async () => {
    const record = fold({
      run: { ...run, status: 'cancelled' },
      events: [
        node('node_failed', 'build', { error: 'first attempt' }),
        node('node_started', 'build'),
        node('node_completed', 'build', { node_output: 'success' }),
        node('node_completed', 'discover', { node_output: 'old' }),
        node('node_started', 'discover'),
        node('node_suspended', 'discover', { suspend_point: 'wait' }),
      ],
    });
    expect(record.first_failed_node).toBeNull();
    expect(record.nodes[0]).toEqual({ node_id: 'discover', state: 'running' });
    expect(record.returns).toEqual({
      availability: 'unavailable',
      node_id: 'discover',
      reason: 'node_not_completed',
    });
  });

  it("carries a fan-out node's slot record through a replay, and drops it when the node restarts", () => {
    const fanOut = fanOutOutcome([
      { index: 0, outcome: 'completed', child_run_id: 'c0' },
      { index: 1, outcome: 'not_started', error: 'refused' },
    ]);
    const states = (events: TerminalRecordEvent[]) =>
      buildRunNodeStates(run, events).find(n => n.node_id === 'build');
    const completed = node('node_completed', 'build', {
      node_output: '[]',
      fan_out_outcome: fanOut,
    });
    expect(states([completed])).toEqual({
      node_id: 'build',
      state: 'completed',
      fan_out_outcome: fanOut,
    });
    expect(states([completed, node('node_skipped_prior_success', 'build')])).toEqual({
      node_id: 'build',
      state: 'completed',
      fan_out_outcome: fanOut,
    });
    expect(states([completed, node('node_started', 'build')])).toEqual({
      node_id: 'build',
      state: 'running',
    });
    expect(
      states([node('node_failed', 'build', { error: 'refused all', fan_out_outcome: fanOut })])
    ).toEqual({ node_id: 'build', state: 'failed', error: 'refused all', fan_out_outcome: fanOut });
  });

  it('keeps spilled outputs as explicit pointers and distinguishes absent from empty output', async () => {
    const record = fold({
      run,
      events: [
        node('node_completed', 'discover', {
          node_output: 'preview',
          node_output_truncated: true,
          node_output_spill_path: '/not/read',
          node_output_original_bytes: 999999,
        }),
      ],
    });
    expect(record.returns).toEqual({
      availability: 'truncated',
      node_id: 'discover',
      spill_path: '/not/read',
      original_bytes: 999999,
    });
    expect(fold({ run, events: [node('node_completed', 'discover')] }).returns).toMatchObject({
      reason: 'output_not_persisted',
    });
    expect(
      fold({
        run,
        events: [node('node_skipped_prior_success', 'discover', { node_output: '' })],
      }).returns
    ).toEqual({ availability: 'available', node_id: 'discover', value: '' });
    expect(fold({ run: { ...run, metadata: {} }, events: [] }).returns).toMatchObject({
      reason: 'graph_unavailable',
    });
  });

  it('surfaces malformed persisted records instead of treating corruption as history', () => {
    expect(() =>
      getTerminalRecord('failed', [
        { event_type: 'workflow_failed', data: { terminal_record: {} } },
      ])
    ).toThrow();
  });

  it('records why a run keeps the worktree it created, and nothing for one it did not', async () => {
    const owned_worktree = {
      envId: 'env-1',
      creationId: '00000000-0000-4000-8000-000000000001',
    };
    const disposition = async (
      status: 'completed' | 'failed' | 'cancelled',
      metadata: Record<string, unknown>
    ): Promise<unknown> =>
      fold({ run: { ...run, status, metadata }, events: [] }).worktree_disposition;

    expect(await disposition('failed', { owned_worktree })).toEqual({
      disposition: 'retained',
      reason: 'resumable',
    });
    expect(await disposition('cancelled', { owned_worktree })).toEqual({
      disposition: 'retained',
      reason: 'cancelled',
    });
    const assessed = { disposition: 'retained', reason: 'unpushed_commits', detail: '2' };
    expect(
      await disposition('completed', {
        owned_worktree,
        [WORKTREE_DISPOSITION_METADATA_KEY]: assessed,
      })
    ).toEqual(assessed);
    expect(await disposition('completed', { owned_worktree })).toBeUndefined();
    expect(
      await disposition('failed', {
        [WORKTREE_DISPOSITION_METADATA_KEY]: { disposition: 'release' },
      })
    ).toBeUndefined();
  });
});
