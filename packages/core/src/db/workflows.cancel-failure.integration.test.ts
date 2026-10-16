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

test.each([
  { successfulSibling: false, cancel: false },
  { successfulSibling: true, cancel: false },
  { successfulSibling: false, cancel: true },
  { successfulSibling: true, cancel: true },
])(
  'failure notification preserves the committed outcome (%j)',
  async ({ successfulSibling, cancel }) => {
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
    let cancelledDuringNotification = false;
    const liveFailureStatuses: ReturnType<typeof store.getWorkflowRunStatus>[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      if (event.runId === run.id && event.type === 'workflow_failed') {
        liveFailureStatuses.push(store.getWorkflowRunStatus(run.id));
      }
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
            if (cancel) {
              expect(await store.cancelWorkflowRun(run.id)).toEqual({ cancelled: true });
              cancelledDuringNotification = true;
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
    expect(await Promise.all(liveFailureStatuses)).toEqual(cancel ? [] : ['failed']);
    expect(cancelledDuringNotification).toBe(cancel);
    expect(await store.getWorkflowRunStatus(run.id)).toBe(cancel ? 'cancelled' : 'failed');
    const events = await store.listWorkflowEvents(run.id);
    expect(events.filter(event => event.event_type === 'workflow_cancelled')).toHaveLength(
      cancel ? 1 : 0
    );
    expect(events.filter(event => event.event_type === 'workflow_failed')).toHaveLength(
      cancel ? 0 : 1
    );
  }
);
