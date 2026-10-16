// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerRegistry } from '@archon/providers';
import { trackTempRoots } from '@archon/paths/test-utils';
import { getWorkflowEventEmitter } from '@archon/workflows/event-emitter';
import type { WorkflowConfig } from '@archon/workflows/deps';
import { executeTestDagWorkflow, makeTestResolvedWorkflow } from '@archon/workflows/test-utils';

const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({ ...paths, isTelemetryDisabled: () => true }));
const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');
afterAll(() => db.close());
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { createWorkflowStore } = await import('../workflows/store-adapter');
const roots = trackTempRoots();
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('cancel-failure-conv', 'web', 'cancel-failure-conv')`,
  []
);

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

test.each(
  [false, true].flatMap(successfulSibling =>
    (['none', 'cancel', 'fail'] as const).map(race => ({ successfulSibling, race }))
  )
)(
  'failure notification preserves the committed outcome (%j)',
  async ({ successfulSibling, race }) => {
    const cwd = roots(await mkdtemp(join(tmpdir(), 'archon-cancel-failure-')));
    const store = createWorkflowStore();
    const run = await store.createWorkflowRun({
      workflow_name: 'cancel-failure',
      origin: { conversationId: 'cancel-failure-conv' },
      user_message: '',
    });
    await store.updateWorkflowRun(run.id, { status: 'running' });
    const workflow = makeTestResolvedWorkflow({
      name: run.workflow_name,
      nodes: [
        ...(successfulSibling ? [{ id: 'ok', bash: 'echo ok' }] : []),
        { id: 'bad', bash: 'exit 3' },
      ],
    });
    let racedDuringNotification = false;
    const liveFailures: string[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      if (event.runId === run.id && event.type === 'workflow_failed')
        liveFailures.push(event.error);
    });
    try {
      await executeTestDagWorkflow({
        deps: {
          store,
          providers: providerRegistry,
          loadConfig: async () => config,
          getAgentProvider: () => {
            throw new Error('Unexpected AI provider');
          },
        },
        workflow,
        workflowRun: { ...run, status: 'running' },
        cwd,
        platform: {
          sendMessage: async (_id, message) => {
            if (!message.startsWith('❌ DAG workflow')) return;
            expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
            if (race === 'cancel') {
              expect(await store.cancelWorkflowRun(run.id)).toEqual({ cancelled: true });
              racedDuringNotification = true;
            } else if (race === 'fail') {
              expect(await store.failWorkflowRun(run.id, 'competing failure')).toEqual({
                failed: true,
              });
              racedDuringNotification = true;
            }
          },
          getStreamingMode: () => 'batch',
          getPlatformType: () => 'test',
        },
        conversationId: 'cancel-failure-conv',
        workflowProvider: 'claude',
        workflowModel: undefined,
        artifactsDir: join(cwd, 'artifacts'),
        stateDir: join(cwd, 'state'),
        logDir: join(cwd, 'logs'),
        baseBranch: 'dev',
        docsDir: 'docs',
        config,
      });
    } finally {
      unsubscribe();
    }
    // The run's own failure is announced only when its write committed it; the
    // competing writer announces through its own path, not this executor's.
    expect(liveFailures).toEqual(
      race === 'none' ? [expect.stringContaining(`DAG workflow '${run.workflow_name}'`)] : []
    );
    expect(racedDuringNotification).toBe(race !== 'none');
    expect(await store.getWorkflowRunStatus(run.id)).toBe(
      race === 'cancel' ? 'cancelled' : 'failed'
    );
    const events = await store.listWorkflowEvents(run.id);
    expect(events.filter(event => event.event_type === 'workflow_cancelled')).toHaveLength(
      race === 'cancel' ? 1 : 0
    );
    const failures = events.filter(event => event.event_type === 'workflow_failed');
    expect(failures.map(event => event.data.error)).toEqual(
      race === 'cancel'
        ? []
        : race === 'fail'
          ? ['competing failure']
          : [expect.stringContaining(`DAG workflow '${run.workflow_name}'`)]
    );
  }
);
