import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { writeNodeArtifact } from './artifacts-index';
import { observeArtifactManifest } from './terminal-artifact-manifest';
import {
  buildTerminalRecord,
  getTerminalRecord,
  type TerminalRecordEvent,
} from './terminal-record';
import { RUN_GRAPH_METADATA_KEY } from './schemas/terminal-record';

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

  it('distinguishes an unreadable directory listing from an empty inventory', async () => {
    const root = await scratch();
    const file = join(root, 'file');
    await writeFile(file, 'contents');
    expect((await observeArtifactManifest(file)).limitations).toEqual([
      { path: '', kind: 'unreadable', code: 'ENOTDIR' },
    ]);
  });
});

describe('durable terminal projection', () => {
  it('preserves structured return values, failure cascades, and unstarted nodes without a report node', async () => {
    const record = await buildTerminalRecord({
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

  it('replay replaces stale success/failure and cancellation truthfully retains running states', async () => {
    const record = await buildTerminalRecord({
      run: { ...run, status: 'cancelled' },
      events: [
        node('node_failed', 'build', { error: 'first attempt' }),
        node('node_started', 'build'),
        node('node_completed', 'build', { node_output: 'success' }),
        node('node_completed', 'discover', { node_output: 'old' }),
        node('node_started', 'discover'),
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

  it('keeps spilled outputs as explicit pointers and distinguishes absent from empty output', async () => {
    const record = await buildTerminalRecord({
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
    expect(
      (await buildTerminalRecord({ run, events: [node('node_completed', 'discover')] })).returns
    ).toMatchObject({ reason: 'output_not_persisted' });
    expect(
      (
        await buildTerminalRecord({
          run,
          events: [node('node_skipped_prior_success', 'discover', { node_output: '' })],
        })
      ).returns
    ).toEqual({ availability: 'available', node_id: 'discover', value: '' });
    expect(
      (await buildTerminalRecord({ run: { ...run, metadata: {} }, events: [] })).returns
    ).toMatchObject({ reason: 'graph_unavailable' });
  });

  it('surfaces malformed persisted records instead of treating corruption as history', () => {
    expect(() =>
      getTerminalRecord('failed', [
        { event_type: 'workflow_failed', data: { terminal_record: {} } },
      ])
    ).toThrow();
  });
});
