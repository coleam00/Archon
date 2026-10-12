import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { loadConfig } from '@archon/core/config/config-loader';
import { canonicalizeProjectPath, getProjectStoragePaths } from '@archon/paths';
import { stateCommand } from './state';
import {
  createInMemoryWorkflowStore,
  createInMemoryWorkflowHostStore,
} from '../test-support/workflow-store';

const track = trackTempRoots();
const priorEnv = { ...process.env };
afterEach(() => {
  process.env = { ...priorEnv };
});
async function fixture() {
  const root = track(mkdtempSync(join(tmpdir(), 'state-cli-')));
  process.env.ARCHON_HOME = join(root, 'home');
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  const host = {
    records,
    deps: {
      store,
      providers: providerRegistry,
      loadConfig,
      getAgentProvider: (): never => {
        throw new Error('No provider');
      },
    },
  };
  const output: unknown[] = [];
  const run = await store.createWorkflowRun({ workflow_name: 'state', user_message: '' });
  await store.updateWorkflowRun(run.id, {
    output_root: getProjectStoragePaths({ kind: 'repo', owner: 'owner', repo: 'repo' }).root,
  });
  const env = {
    WORKFLOW_ID: run.id,
    ARCHON_NODE_EXECUTION: JSON.stringify({ runId: run.id, path: 'review/commit' }),
  };
  const invoke = (
    op: string,
    input = '',
    flags: { ifRevision?: string; limit?: string } = {},
    override: NodeJS.ProcessEnv = env
  ) =>
    stateCommand(
      host,
      op,
      ['review/123'],
      { cwd: root, ...flags },
      {
        env: override,
        readInput: async () => input,
        write: async value => {
          output.push(value);
        },
        storeKind: 'sqlite',
      }
    );
  return { invoke, output, store, run, env, host, root };
}
test('JSON commands preserve run attribution, audit, CAS and tombstone recreation', async () => {
  const { invoke, output } = await fixture();
  expect(await invoke('get')).toBe(0);
  expect(output.at(-1)).toEqual({ name: 'review/123', revision: 0, value: null });
  expect(await invoke('put', '{"seen":[]}', { ifRevision: '0' })).toBe(0);
  expect(output.at(-1)).toMatchObject({
    revision: 1,
    writer: { kind: 'run', nodePath: 'review/commit' },
  });
  expect(await invoke('put', '{}', { ifRevision: '0' })).toBe(3);
  expect(await invoke('patch', '{"ops":[{"op":"append","path":"/seen","value":123}]}')).toBe(0);
  expect(await invoke('get')).toBe(0);
  expect(output.at(-1)).toEqual({ name: 'review/123', revision: 2, value: { seen: [123] } });
  expect(await invoke('log', '', { limit: '1' })).toBe(0);
  expect(output.at(-1)).toMatchObject([
    { revision: 2, operation: { op: 'patch' }, writer: { kind: 'run' } },
  ]);
  expect(await invoke('delete', '', { ifRevision: '2' })).toBe(0);
  expect(await invoke('put', '{}', { ifRevision: '3' })).toBe(0);
});
test('mismatched store, absent project and invalid identity refuse without writes', async () => {
  const { invoke, output, store, env } = await fixture();
  expect(await invoke('put', '{}', { ifRevision: '0' }, { ...env, WORKFLOW_ID: 'missing' })).toBe(
    1
  );
  expect(output.at(-1)).toMatchObject({
    error: expect.stringContaining('different store than the engine: sqlite'),
    code: 1,
  });
  expect(
    await invoke(
      'put',
      '{}',
      { ifRevision: '0' },
      { ...env, ARCHON_NODE_EXECUTION: JSON.stringify({ runId: 'wrong', path: 'commit' }) }
    )
  ).toBe(1);
  for (const identity of [undefined, '', '{', '{"runId":"x"}']) {
    const { ARCHON_NODE_EXECUTION: _, ...withoutIdentity } = env;
    expect(
      await invoke(
        'put',
        '{}',
        { ifRevision: '0' },
        identity === undefined
          ? withoutIdentity
          : { ...withoutIdentity, ARCHON_NODE_EXECUTION: identity }
      )
    ).toBe(1);
    expect(output.at(-1)).toMatchObject({
      error: 'WORKFLOW_ID requires ARCHON_NODE_EXECUTION as JSON with runId and path',
    });
  }
  const unscoped = await store.createWorkflowRun({ workflow_name: 'state', user_message: '' });
  expect(
    await invoke(
      'put',
      '{}',
      { ifRevision: '0' },
      {
        WORKFLOW_ID: unscoped.id,
        ARCHON_NODE_EXECUTION: JSON.stringify({ runId: unscoped.id, path: 'commit' }),
      }
    )
  ).toBe(1);
  expect(output.at(-1)).toMatchObject({ error: 'The run has no resolvable project root' });
  expect(await store.listStateRevisions('owner/repo', 'review/123')).toEqual([]);
});
test('usage, cap and patch errors have distinct codes and write nothing', async () => {
  const { invoke, output, store } = await fixture();
  expect(await invoke('put', '{}')).toBe(1);
  expect(await invoke('put', '{}', { ifRevision: '-1' })).toBe(1);
  expect(await invoke('put', JSON.stringify('x'.repeat(65536)), { ifRevision: '0' })).toBe(4);
  expect(await invoke('patch', '{')).toBe(4);
  expect(await invoke('patch', '{"ops":[{"op":"append","path":"bad","value":1}]}')).toBe(4);
  expect(output.at(-1)).toMatchObject({ ok: false, code: 4 });
  expect(
    await invoke(
      'patch',
      '{"ops":[{"op":"set","path":"/a","value":1},{"op":"append","path":"/a","value":2}]}'
    )
  ).toBe(4);
  expect(await store.listStateRevisions('owner/repo', 'review/123')).toEqual([]);
});
test('operator identity and registered folder project use the same durable scope', async () => {
  const { host, root, output } = await fixture();
  // Registration stores the canonical path; the operator's cwd may be a symlink or,
  // on Windows, the 8.3 short name the runner's temp directory already uses.
  const folder = join(root, 'ops');
  mkdirSync(folder);
  const alias = process.platform === 'win32' ? folder : join(root, 'ops-alias');
  if (alias !== folder) symlinkSync(folder, alias);
  await host.records.codebases.createCodebase({
    name: 'Ops',
    default_cwd: await canonicalizeProjectPath(folder),
    kind: 'folder',
  });
  expect(
    await stateCommand(
      host,
      'put',
      ['ledger'],
      { cwd: alias, ifRevision: '0' },
      {
        env: { ARCHON_USER_ID: 'rasmus' },
        readInput: async () => '{}',
        write: async row => {
          output.push(row);
        },
      }
    )
  ).toBe(0);
  expect(output.at(-1)).toMatchObject({ writer: { kind: 'operator', identity: 'rasmus' } });
  expect((await host.deps.store.getStateDocument('_folder/ops', 'ledger'))?.revision).toBe(1);
});

test('JSON input keeps own prototype keys and enforces their size', async () => {
  const { invoke, output } = await fixture();
  const source = '{"__proto__":{"kept":true},"nested":[{"__proto__":null}]}';
  expect(await invoke('put', source, { ifRevision: '0' })).toBe(0);
  expect(await invoke('get')).toBe(0);
  expect(output.at(-1)).toMatchObject({ value: JSON.parse(source) });
  expect(await invoke('patch', `{"ops":[{"op":"set","path":"/added","value":${source}}]}`)).toBe(0);
  expect(output.at(-1)).toMatchObject({
    value: { ...JSON.parse(source), added: JSON.parse(source) },
  });
  const oversized = `{"__proto__":"${'x'.repeat(65536)}"}`;
  expect(await invoke('put', oversized, { ifRevision: '2' })).toBe(4);
  expect(await invoke('patch', `{"ops":[{"op":"set","path":"/large","value":${oversized}}]}`)).toBe(
    4
  );
  expect(await invoke('log')).toBe(0);
  expect(output.at(-1)).toHaveLength(2);
});
