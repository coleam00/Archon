import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from '@hono/zod-openapi';
import * as paths from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers';
import type { WorkflowDeps, WorkflowConfig } from '@archon/workflows/deps';
import { WORKFLOW_EVENT_TYPES, type IWorkflowStore } from '@archon/workflows/store';
import { RUN_GRAPH_METADATA_KEY } from '@archon/workflows/schemas/terminal-record';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { buildTerminalRecord, type TerminalRecordEvent } from '@archon/workflows/terminal-record';
import { executeTestDagWorkflow, makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const query = createMockQuery();
mock.module('./connection', () => ({
  pool: { query },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql',
  getDatabase: () => {
    throw new Error('Unexpected transaction in event replay test');
  },
}));
const { getDagResumeSnapshot } = await import('./workflow-events');
const { createWorkflowStore } = await import('../workflows/store-adapter');
registerBuiltinProviders();
const telemetry = spyOn(paths, 'captureWorkflowCompleted').mockImplementation(() => {});
let scratch: string | undefined;
afterEach(async () => {
  telemetry.mockRestore();
  if (scratch) await removeTempTree(scratch);
});

// Database transport and the injected insert failure are the only event-path mocks.
// Hydration, invalidation, both DAG passes and terminal projection execute real code.
test('a second resume recomputes output invalidated before a rejected node start', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'archon-resume-invalidation-'));
  const rows: TerminalRecordEvent[] = [
    { event_type: 'node_completed', step_name: 'upstream', data: { node_output: 'a1' } },
    { event_type: 'node_completed', step_name: 'consumer', data: { node_output: 'b1' } },
  ];
  let rejectConsumerStart = true;
  query.mockImplementation(async (...args) => {
    const [sql, params] = z.tuple([z.string(), z.array(z.unknown())]).parse(args);
    if (sql.startsWith('INSERT INTO remote_agent_workflow_events')) {
      const eventType = z.enum(WORKFLOW_EVENT_TYPES).parse(params?.[2]);
      const stepName = z.string().nullable().parse(params?.[4]);
      if (rejectConsumerStart && eventType === 'node_started' && stepName === 'consumer') {
        throw new Error('consumer start insert rejected');
      }
      rows.push({
        event_type: eventType,
        step_name: stepName,
        data: z.string().parse(params?.[5]),
      });
      return createQueryResult([]);
    }
    if (sql.startsWith('SELECT step_name, event_type, data')) {
      return createQueryResult(rows.filter(row => params?.includes(row.event_type)));
    }
    throw new Error(`Unexpected test query: ${sql}`);
  });
  const run: WorkflowRun = {
    id: 'resume-invalidation',
    workflow_name: 'resume-invalidation',
    conversation_id: 'test',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: '',
    metadata: {
      [RUN_GRAPH_METADATA_KEY]: { node_ids: ['upstream', 'consumer'], returns: 'consumer' },
    },
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    adopted_from_run_id: null,
  };
  const store: IWorkflowStore = {
    ...createWorkflowStore(),
    getWorkflowRun: async () => run,
    getWorkflowRunStatus: async () => 'running',
    updateWorkflowRun: async () => {},
    updateWorkflowActivity: async () => {},
    completeWorkflowRun: async () => {},
    failWorkflowRun: async () => {},
    getWorkflowNodeSession: async () => null,
    listWorkflowRunNodeSessions: async () => [],
  };
  const config: WorkflowConfig = {
    assistant: 'claude',
    assistants: { claude: {}, codex: {} },
    commands: {},
    defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
  };
  const deps: WorkflowDeps = {
    store,
    loadConfig: async () => config,
    getAgentProvider: () => {
      throw new Error('This exec-only workflow must not call an AI provider');
    },
  };
  const workflow = makeTestResolvedWorkflow({
    name: run.workflow_name,
    returns: 'consumer',
    nodes: [
      { id: 'upstream', bash: 'echo a2', always_run: true },
      { id: 'consumer', bash: 'echo b2', depends_on: ['upstream'] },
    ],
  });
  const options = {
    deps,
    workflow,
    workflowRun: run,
    cwd: scratch,
    platform: {
      sendMessage: async () => {},
      getStreamingMode: () => 'batch' as const,
      getPlatformType: () => 'test',
    },
    conversationId: 'test',
    workflowProvider: 'claude',
    workflowModel: undefined,
    artifactsDir: join(scratch, 'artifacts'),
    stateDir: join(scratch, 'state'),
    logDir: join(scratch, 'logs'),
    baseBranch: 'dev',
    docsDir: 'docs',
    config,
  };
  const first = await getDagResumeSnapshot(run.id);
  await expect(
    executeTestDagWorkflow({ ...options, priorCompletedNodes: first.completedNodeOutputs })
  ).rejects.toThrow('consumer start insert rejected');
  expect(
    rows.some(
      row => row.event_type === 'node_prior_cache_invalidated' && row.step_name === 'consumer'
    )
  ).toBe(true);
  const failed = await buildTerminalRecord({ run: { ...run, status: 'failed' }, events: rows });
  expect(failed.returns).toMatchObject({
    availability: 'unavailable',
    reason: 'node_not_completed',
  });

  rejectConsumerStart = false;
  const second = await getDagResumeSnapshot(run.id);
  expect(second.completedNodeOutputs.has('consumer')).toBe(false);
  await executeTestDagWorkflow({ ...options, priorCompletedNodes: second.completedNodeOutputs });
  const completed = await buildTerminalRecord({
    run: { ...run, status: 'completed' },
    events: rows,
  });
  expect(completed.returns).toEqual({
    availability: 'available',
    node_id: 'consumer',
    value: 'b2',
  });
});
