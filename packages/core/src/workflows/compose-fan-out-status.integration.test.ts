// @archon-test-isolated
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { providerRegistry } from '@archon/providers';
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

test('composed fan-out preserves an unsupported persisted parent status after instances settle', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'compose-status-')));
  const originalHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  try {
    registerBuiltinProviders();
    await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(root, '.archon', 'workflows', 'block.yaml'),
      'name: block\ndescription: deterministic work\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: echo done\n'
    );
    const store = createWorkflowStore();
    const persist = store.persistWorkflowEvent.bind(store);
    let runId: string | undefined;
    store.persistWorkflowEvent = async event => {
      await persist(event);
      if (
        event.event_type === 'node_completed' &&
        event.data?.type === 'compose_fan_out_instance'
      ) {
        runId = event.workflow_run_id;
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          'unsupported',
          runId,
        ]);
      }
    };
    const statusReadErrors: unknown[] = [];
    const readStatus = store.getWorkflowRunStatus.bind(store);
    store.getWorkflowRunStatus = async id => {
      try {
        return await readStatus(id);
      } catch (error) {
        statusReadErrors.push(error);
        throw error;
      }
    };
    const fail = spyOn(store, 'failWorkflowRun');
    const complete = spyOn(store, 'completeWorkflowRun');
    const pause = spyOn(store, 'pauseWorkflowRun');
    const deps: WorkflowDeps = {
      store,
      providers: providerRegistry,
      getAgentProvider: () => {
        throw new Error('Unexpected agent work');
      },
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
    const error = await executeWorkflow(
      deps,
      platform,
      'test',
      root,
      makeTestResolvedWorkflow({
        name: 'parent',
        nodes: [
          {
            id: 'fan',
            kind: 'compose_fan_out',
            include: 'block',
            fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: 'all_success' },
          },
        ],
      }),
      '',
      undefined,
      { resolvedBaseBranch: 'main' }
    ).catch((error: unknown) => error);
    expect(statusReadErrors).toHaveLength(1);
    const [originalError] = statusReadErrors;
    expect(error).toMatchObject({ name: 'ParentStatusReadError', cause: originalError });
    expect(originalError).toBeInstanceOf(WorkflowStatusReadError);
    expect(originalError).toMatchObject({ workflowRunId: runId, storedStatus: 'unsupported' });
    if (!(error instanceof Error)) throw new Error('Expected lifecycle-read error');
    expect(error.cause).toBe(originalError);
    expect(runId).toBeDefined();
    if (!runId) throw new Error('Instance did not settle');
    const events = await store.listWorkflowEvents(runId);
    expect(
      events.filter(event => event.event_type === 'node_completed').map(event => event.data.type)
    ).toEqual(['bash', 'compose_fan_out_instance']);
    expect(events.some(event => event.event_type === 'node_failed')).toBe(false);
    expect(fail).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT status FROM remote_agent_workflow_runs WHERE id = $1', [runId])).rows
    ).toEqual([{ status: 'unsupported' }]);
  } finally {
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
  }
});
