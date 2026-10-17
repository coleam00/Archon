import { spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { loadConfig } from '@archon/core/config/config-loader';
import { canonicalizeProjectPath, getProjectStoragePaths } from '@archon/paths';
import { stateCommand, type StateCommandOptions } from './state';
import {
  createInMemoryWorkflowStore,
  createInMemoryWorkflowHostStore,
} from '../test-support/workflow-store';

const track = trackTempRoots();
const project = { kind: 'project', key: 'owner/repo' } as const;
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
    flags: Partial<Omit<StateCommandOptions, 'cwd'>> = {},
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
  expect(output.at(-1)).toEqual({ scope: project, name: 'review/123', revision: 0, value: null });
  expect(await invoke('put', '{"seen":[]}', { ifRevision: '0' })).toBe(0);
  expect(output.at(-1)).toMatchObject({
    revision: 1,
    writer: { kind: 'run', nodePath: 'review/commit' },
  });
  expect(await invoke('put', '{}', { ifRevision: '0' })).toBe(3);
  expect(await invoke('patch', '{"ops":[{"op":"append","path":"/seen","value":123}]}')).toBe(0);
  expect(await invoke('get')).toBe(0);
  expect(output.at(-1)).toEqual({
    scope: project,
    name: 'review/123',
    revision: 2,
    value: { seen: [123] },
  });
  expect(await invoke('log', '', { limit: '1' })).toBe(0);
  expect(output.at(-1)).toMatchObject({
    scope: project,
    revisions: [{ revision: 2, operation: { op: 'patch' }, writer: { kind: 'run' } }],
  });
  expect(await invoke('delete', '', { ifRevision: '2' })).toBe(0);
  expect(await invoke('put', '{}', { ifRevision: '3' })).toBe(0);
});
test('get on a deleted document returns the revision a recreating put must name', async () => {
  const { invoke, output } = await fixture();
  expect(await invoke('put', '{"a":1}', { ifRevision: '0' })).toBe(0);
  expect(await invoke('delete', '', { ifRevision: '1' })).toBe(0);
  expect(await invoke('get')).toBe(0);
  expect(output.at(-1)).toEqual({
    scope: project,
    name: 'review/123',
    revision: 2,
    value: null,
    deleted: true,
  });
  const { revision } = output.at(-1) as { revision: number };
  expect(await invoke('put', '{"a":2}', { ifRevision: String(revision) })).toBe(0);
  expect(output.at(-1)).toMatchObject({ revision: 3, value: { a: 2 } });
});
test('mismatched store, absent project and invalid identity refuse without writes', async () => {
  const { invoke, output, store, env } = await fixture();
  expect(await invoke('put', '{}', { ifRevision: '0' }, { ...env, WORKFLOW_ID: 'missing' })).toBe(
    5
  );
  expect(output.at(-1)).toMatchObject({
    error: expect.stringContaining('different store than the engine: sqlite'),
    code: 5,
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
  expect(await store.listStateRevisions(project, 'review/123')).toEqual([]);
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
  expect(await store.listStateRevisions(project, 'review/123')).toEqual([]);
});
test('an operator write records the CLI surface in the registered folder project', async () => {
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
        env: {},
        readInput: async () => '{}',
        write: async row => {
          output.push(row);
        },
      }
    )
  ).toBe(0);
  expect(output.at(-1)).toMatchObject({ writer: { kind: 'surface', via: 'cli' } });
  expect(
    (await host.deps.store.getStateDocument({ kind: 'project', key: '_folder/ops' }, 'ledger'))
      ?.revision
  ).toBe(1);
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
  expect((output.at(-1) as { revisions: unknown[] }).revisions).toHaveLength(2);
});

test('operator state from a folder descendant inside Git belongs only to the folder', async () => {
  const { host, root } = await fixture();
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
  await host.records.codebases.createCodebase({
    name: 'owner/repo',
    default_cwd: await canonicalizeProjectPath(root),
    kind: 'repo',
  });
  const folder = join(root, 'ops');
  const descendant = join(folder, 'deep');
  mkdirSync(descendant, { recursive: true });
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
      { cwd: descendant, ifRevision: '0' },
      {
        env: {},
        readInput: async () => '{"approved":true}',
        write: async () => undefined,
      }
    )
  ).toBe(0);
  expect(
    await host.deps.store.getStateDocument({ kind: 'project', key: '_folder/ops' }, 'ledger')
  ).toMatchObject({
    revision: 1,
    value: { approved: true },
  });
  expect(await host.deps.store.getStateDocument(project, 'ledger')).toBeNull();
});

test('a patch that names a stale revision exits 3 and writes nothing', async () => {
  const { invoke, output, store } = await fixture();
  expect(await invoke('put', '{"owner":"a"}', { ifRevision: '0' })).toBe(0);
  expect(await invoke('patch', '{"ops":[{"op":"set","path":"/owner","value":"b"}]}')).toBe(0);
  expect(
    await invoke('patch', '{"ops":[{"op":"set","path":"/owner","value":"c"}]}', {
      ifRevision: '1',
    })
  ).toBe(3);
  expect(output.at(-1)).toMatchObject({ ok: false, code: 3 });
  expect(
    await invoke('patch', '{"ops":[{"op":"set","path":"/owner","value":"c"}]}', {
      ifRevision: '2',
    })
  ).toBe(0);
  expect(output.at(-1)).toMatchObject({ revision: 3, operation: { ifRevision: 2 } });
  expect(await store.listStateRevisions(project, 'review/123')).toHaveLength(3);
});

test('install scope is separate from the run project and keeps run attribution', async () => {
  const { invoke, output, store, run } = await fixture();
  expect(await invoke('put', '"install"', { ifRevision: '0', install: true })).toBe(0);
  expect(output.at(-1)).toMatchObject({
    scope: { kind: 'install' },
    writer: { kind: 'run', runId: run.id },
  });
  expect(await invoke('get')).toBe(0);
  expect(output.at(-1)).toMatchObject({ scope: project, revision: 0, value: null });
  expect((await store.getStateDocument({ kind: 'install' }, 'review/123'))?.value).toBe('install');
  expect(await invoke('get', '', { project: 'other/repo' })).toBe(1);
  expect(output.at(-1)).toMatchObject({ error: expect.stringContaining('outside a run') });
});

test('outside a run, --project and --install address scopes without the cwd', async () => {
  const { host, root, output, store } = await fixture();
  const call = (
    op: string,
    flags: Partial<Omit<StateCommandOptions, 'cwd'>>,
    input = '',
    name = 'notes/a'
  ) =>
    stateCommand(
      host,
      op,
      op === 'list' ? [] : [name],
      { cwd: root, ...flags },
      {
        env: {},
        readInput: async () => input,
        write: async value => {
          output.push(value);
        },
      }
    );
  expect(await call('put', { project: 'acme/widgets', ifRevision: '0' }, '{"n":1}')).toBe(0);
  expect(output.at(-1)).toMatchObject({ writer: { kind: 'surface', via: 'cli' } });
  expect(
    (await store.getStateDocument({ kind: 'project', key: 'acme/widgets' }, 'notes/a'))?.value
  ).toEqual({ n: 1 });
  expect(await call('list', { project: 'acme/widgets', prefix: 'notes/' })).toBe(0);
  expect(output.at(-1)).toEqual({
    scope: { kind: 'project', key: 'acme/widgets' },
    documents: [
      {
        name: 'notes/a',
        revision: 1,
        updatedAt: expect.any(String),
        writer: { kind: 'surface', via: 'cli' },
        deleted: false,
      },
    ],
  });
  expect(
    await call('put', { project: 'acme/widgets', ifRevision: '0' }, '{"n":2}', 'notes/b')
  ).toBe(0);
  expect(await call('delete', { project: 'acme/widgets' }, '', 'notes/b')).toBe(0);
  expect(await call('list', { project: 'acme/widgets', prefix: 'notes/', values: true })).toBe(0);
  expect(output.at(-1)).toEqual({
    scope: { kind: 'project', key: 'acme/widgets' },
    documents: [{ name: 'notes/a', revision: 1, value: { n: 1 } }],
  });
  expect(await call('get', { project: 'acme/widgets', values: true })).toBe(1);
  expect(await call('list', { install: true })).toBe(0);
  expect(output.at(-1)).toEqual({ scope: { kind: 'install' }, documents: [] });
  // A one-segment key is the install scope's storage key, never a project.
  expect(await call('get', { project: '_install' })).toBe(1);
  expect(await call('get', { project: 'x', install: true })).toBe(1);
});

test('--raw reads and writes a text value as is', async () => {
  const { invoke, output, host, env, root } = await fixture();
  const text = '# Notes\n\n- "quoted" line\n';
  expect(await invoke('put', text, { ifRevision: '0', raw: true })).toBe(0);
  expect(output.at(-1)).toMatchObject({ revision: 1, value: text });
  const printed: string[] = [];
  const get = () =>
    stateCommand(
      host,
      'get',
      ['review/123'],
      { cwd: root, raw: true },
      {
        env,
        write: async value => {
          output.push(value);
        },
        writeRaw: async value => {
          printed.push(value);
        },
      }
    );
  expect(await get()).toBe(0);
  expect(printed).toEqual([text]);
  expect(await invoke('put', '{"not":"text"}', { ifRevision: '1' })).toBe(0);
  expect(await get()).toBe(4);
  expect(printed).toHaveLength(1);
  expect(await invoke('log', '', { raw: true })).toBe(1);
});
