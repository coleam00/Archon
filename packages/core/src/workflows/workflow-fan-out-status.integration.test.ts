// @archon-test-isolated
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import type { MessageChunk } from '@archon/provider-contract';
import { hydrateResumableRun } from '@archon/workflows/run-resume';
import { getProviderCapabilities, providerRegistry } from '@archon/providers';
import { executeWorkflow } from '@archon/workflows/executor';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { SqliteAdapter, sqliteDialect } from '../db/adapters/sqlite';
import { WorkflowStatusReadError } from '../db/workflow-run-status';

const db = new SqliteAdapter(':memory:');
function unexpectedConnectionCall(): never {
  throw new Error('Unexpected database connection operation in private SQLite test');
}
mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
  getSqliteDbPath: unexpectedConnectionCall,
  getSchemaVersion: unexpectedConnectionCall,
  getDbNotificationListener: unexpectedConnectionCall,
  closeDatabase: unexpectedConnectionCall,
  resetDatabase: unexpectedConnectionCall,
}));
const { createWorkflowStore } = await import('./store-adapter');
const track = trackTempRoots();
afterAll(async () => {
  await db.close();
});

test.each([true, false])(
  'fan-out recovery rejects an unsupported persisted child (mutates checkout: %s)',
  async mutatesCheckout => {
    const root = track(await mkdtemp(join(tmpdir(), 'child-status-')));
    const originalHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    try {
      registerBuiltinProviders();
      await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(root, '.archon', 'workflows', 'child.yaml'),
        'name: child\ndescription: deterministic failing child\nmutates_checkout: false\nnodes:\n  - id: work\n    prompt: do work\n'
      );
      const store = createWorkflowStore();
      let providerCalls = 0;
      const deps: WorkflowDeps = {
        store,
        providers: providerRegistry,
        getAgentProvider: () => ({
          getType: () => 'claude',
          getCapabilities: () => getProviderCapabilities('claude'),
          checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
          sendQuery: async function* (): AsyncGenerator<MessageChunk> {
            providerCalls++;
            yield {
              type: 'result',
              isError: true,
              failure: { class: 'unknown', evidence: 'test failure' },
            };
            yield { type: 'settled' };
          },
        }),
        loadConfig: async () => ({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          commands: {},
          defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        }),
      };
      const platform: IWorkflowPlatform = {
        sendMessage: async () => {},
        getPlatformType: () => 'test',
        getStreamingMode: () => 'batch',
      };
      const workflow = makeTestResolvedWorkflow({
        name: 'parent',
        mutates_checkout: mutatesCheckout,
        nodes: [
          {
            id: 'fan',
            workflow: 'child',
            fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: 'all_success' },
          },
        ],
      });
      const first = await executeWorkflow(deps, platform, 'test', root, workflow, '', undefined, {
        resolvedBaseBranch: 'main',
      });
      expect(first.success).toBe(false);
      expect(providerCalls).toBe(1);
      if (!first.workflowRunId) throw new Error('Missing parent run ID');
      const parent = await store.getWorkflowRun(first.workflowRunId);
      if (!parent) throw new Error('Missing parent');
      expect(parent.status).toBe('failed');
      const children = await store.findChildRuns(parent.id);
      expect(children).toHaveLength(1);
      const child = children[0];
      if (!child) throw new Error('Missing child');
      expect(child.status).toBe('failed');
      await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
        'unsupported',
        child.id,
      ]);
      const hydrated = await hydrateResumableRun(deps, parent);
      if (!hydrated) throw new Error('Missing recovery state');
      const childRows = async () =>
        (
          await db.query(
            'SELECT * FROM remote_agent_workflow_runs WHERE parent_run_id = $1 ORDER BY id',
            [parent.id]
          )
        ).rows;
      const terminalEvents = async () =>
        (await store.listWorkflowEvents(parent.id)).filter(
          event =>
            event.event_type === 'node_failed' ||
            ['workflow_failed', 'workflow_cancelled', 'workflow_completed'].includes(
              event.event_type
            )
        );
      const before = await childRows();
      const eventsBefore = await terminalEvents();
      const fail = spyOn(store, 'failWorkflowRun');
      const cancelRun = spyOn(store, 'cancelWorkflowRun');
      const cancel = spyOn(store, 'cancelFanOutRun');
      const complete = spyOn(store, 'completeWorkflowRun');
      const pause = spyOn(store, 'pauseWorkflowRun');
      const create = spyOn(store, 'createWorkflowRun');
      const result = executeWorkflow(
        deps,
        platform,
        'test',
        root,
        workflow,
        '',
        undefined,
        hydrated
      );
      await expect(result).rejects.toBeInstanceOf(WorkflowStatusReadError);
      await expect(result).rejects.toMatchObject({
        workflowRunId: child.id,
        storedStatus: 'unsupported',
      });
      expect(providerCalls).toBe(1);
      expect(await childRows()).toEqual(before);
      expect(await terminalEvents()).toEqual(eventsBefore);
      expect((await store.getWorkflowRun(parent.id))?.status).toBe('running');
      for (const write of [fail, cancel, cancelRun, complete, pause, create])
        expect(write).not.toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = originalHome;
    }
  }
);

test.each([false, true])(
  'nested launch preserves an unsupported ancestor status (fan-out: %s)',
  async fanOut => {
    const root = track(await mkdtemp(join(tmpdir(), 'ancestor-status-')));
    const originalHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    try {
      registerBuiltinProviders();
      await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(root, '.archon', 'workflows', 'leaf.yaml'),
        'name: leaf\ndescription: leaf\nmutates_checkout: false\nnodes:\n  - id: work\n    prompt: do work\n'
      );
      const store = createWorkflowStore();
      const provider = mock((): never => {
        throw new Error('Unexpected provider call');
      });
      const deps: WorkflowDeps = {
        store,
        providers: providerRegistry,
        getAgentProvider: provider,
        loadConfig: async () => ({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          commands: {},
          defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        }),
      };
      const platform: IWorkflowPlatform = {
        sendMessage: async () => {},
        getPlatformType: () => 'test',
        getStreamingMode: () => 'batch',
      };
      const ancestor = await store.createWorkflowRun({
        workflow_name: 'ancestor',
        user_message: '',
      });
      const descendant = await store.createWorkflowRun({
        workflow_name: 'descendant',
        user_message: '',
        parent_run_id: ancestor.id,
      });
      await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
        'unsupported',
        ancestor.id,
      ]);
      const ancestorRow = async () =>
        (await db.query('SELECT * FROM remote_agent_workflow_runs WHERE id = $1', [ancestor.id]))
          .rows;
      const before = await ancestorRow();
      const writes = [
        spyOn(store, 'failWorkflowRun'),
        spyOn(store, 'cancelWorkflowRun'),
        spyOn(store, 'cancelFanOutRun'),
        spyOn(store, 'completeWorkflowRun'),
        spyOn(store, 'pauseWorkflowRun'),
        spyOn(store, 'createWorkflowRun'),
      ];
      const workflow = makeTestResolvedWorkflow({
        name: 'descendant',
        mutates_checkout: false,
        nodes: [
          {
            id: 'launch',
            workflow: 'leaf',
            ...(fanOut
              ? {
                  fan_out: {
                    items: '[1]',
                    as: 'item',
                    max_parallel: 1,
                    join: 'all_success' as const,
                  },
                }
              : {}),
          },
        ],
      });
      const result = executeWorkflow(deps, platform, 'test', root, workflow, '', undefined, {
        preCreatedRun: descendant,
        resolvedBaseBranch: 'main',
      });
      await expect(result).rejects.toBeInstanceOf(WorkflowStatusReadError);
      await expect(result).rejects.toMatchObject({
        workflowRunId: ancestor.id,
        storedStatus: 'unsupported',
      });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(await ancestorRow()).toEqual(before);
      expect((await store.getWorkflowRun(descendant.id))?.status).toBe('running');
      expect(
        (await store.listWorkflowEvents(descendant.id)).filter(event =>
          ['node_failed', 'workflow_failed', 'workflow_cancelled', 'workflow_completed'].includes(
            event.event_type
          )
        )
      ).toEqual([]);
    } finally {
      if (originalHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = originalHome;
    }
  }
);
