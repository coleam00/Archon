/**
 * The SQL workflow host the commands run on, over the faked DB layer, with an
 * in-memory committed event feed.
 */
import { mock } from 'bun:test';
import type { WorkflowEventCursor } from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowEventRow } from '@archon/core/schemas/workflow-event';
import { mockCreateWorkflowEvent, mockPersistWorkflowEvent } from './workflow-harness-core';
import {
  mockIsRunOwnerAnswering,
  mockReclaimContainerEnv,
  mockRequestDetachedRunStop,
} from './workflow-harness-run-owner';
// The host reads the DB modules, so their fakes must be registered first.
import './workflow-harness-db';

/**
 * The committed event feed behind every test host: rows a mocked executor commits with
 * `commitTestEvent` are what the foreground's run subscription reads and renders.
 */
let committedTestEvents: WorkflowEventRow[] = [];
export function resetCommittedTestEvents(): void {
  committedTestEvents = [];
}
export const testRunParents = new Map<string, string>();
let failTestFeedReads = false;
export function setFailTestFeedReads(value: boolean): void {
  failTestFeedReads = value;
}
export function commitTestEvent(
  row: Omit<WorkflowEventRow, 'id' | 'created_at' | 'step_index'>
): void {
  committedTestEvents.push({
    id: `event-${String(committedTestEvents.length + 1)}`,
    step_index: null,
    created_at: '2026-10-14T00:00:00.000Z',
    ...row,
  });
}
const testFeedCursor = (position: number): WorkflowEventCursor =>
  `test:${String(position)}` as WorkflowEventCursor;

const { createWorkflowOperations } = await import('@archon/core/operations/workflow-operations');
const operationWorkflowDb = await import('@archon/core/db/workflows');
const operationSessionDb = await import('@archon/core/db/workflow-node-sessions');
const operationIsolationDb = await import('@archon/core/db/isolation-environments');
const hostCodebases = await import('@archon/core/db/codebases');
const hostUsers = await import('@archon/core/db/users');
const hostConversations = await import('@archon/core/db/conversations');
const hostMessages = await import('@archon/core/db/messages');
const realCreateSqlWorkflowHost = (await import('@archon/core/workflows/sql-host'))
  .createSqlWorkflowHost;
mock.module('@archon/core/workflows/sql-host', () => ({
  createSqlWorkflowHost: realCreateSqlWorkflowHost,
  createWorkflowHostStore: () => ({
    codebases: hostCodebases,
    users: hostUsers,
    conversations: hostConversations,
    messages: hostMessages,
    isolation: { ...operationIsolationDb.createIsolationStore(), ...operationIsolationDb },
  }),
  createSqlWorkflowOperations: () =>
    createWorkflowOperations({
      getUserRole: async () => undefined,
      store: {
        persistWorkflowEvent: mockPersistWorkflowEvent,
        signalWorkflowWait: (...args) => operationWorkflowDb.signalWorkflowWait(...args),
        deleteWorkflowRun: (...args) => operationWorkflowDb.deleteWorkflowRun(...args),
        getWorkflowRun: (...args) => operationWorkflowDb.getWorkflowRun(...args),
        findChildRuns: (...args) => operationWorkflowDb.findChildRuns(...args),
        getRunAncestry: (...args) => operationWorkflowDb.getRunAncestry(...args),
        cancelWorkflowRun: (...args) => operationWorkflowDb.cancelWorkflowRun(...args),
        resolveApprovalGate: (...args) => operationWorkflowDb.resolveApprovalGate(...args),
        resolveAndCancelApprovalGate: (...args) =>
          operationWorkflowDb.resolveAndCancelApprovalGate(...args),
        answerAttentionWait: (...args) => operationWorkflowDb.answerAttentionWait(...args),
        labelAttentionWait: (...args) => operationWorkflowDb.labelAttentionWait(...args),
        cancelResumableRunsForConversation: (...args) =>
          operationWorkflowDb.cancelResumableRunsForConversation(...args),
        deleteWorkflowNodeSessions: operationSessionDb.deleteWorkflowNodeSessions,
        findWorkflowRunsByIdPrefix: operationWorkflowDb.findWorkflowRunsByIdPrefix,
        listWorkflowRuns: (...args) => operationWorkflowDb.listDashboardRuns(...args),
      },
      hostStore: {
        isolation: {
          ...operationIsolationDb.createIsolationStore(),
          getById: (...args) => operationIsolationDb.getById(...args),
        },
      },
      requestDetachedRunStop: mockRequestDetachedRunStop,
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: mockIsRunOwnerAnswering,
      reclaimRunWorktree: async () => ({ warnings: [] }),
      reclaimContainerEnv: mockReclaimContainerEnv,
    }),
}));

const { createSqlWorkflowHost } = await import('@archon/core/workflows/sql-host');
const coreCapabilities = await import('@archon/core');
const { createSqlWorkflowOperations } = await import('@archon/core/workflows/sql-host');
export function createTestWorkflowHost(): import('@archon/core/workflows/host-store').WorkflowHost {
  const host = createSqlWorkflowHost();
  host.deps.store.pruneStateRevisions = mock(async () => ({ count: 0 }));
  host.deps.store.createWorkflowEvent = mockCreateWorkflowEvent;
  host.deps.store.persistWorkflowEvent = mockPersistWorkflowEvent;
  host.deps.store.getWorkflowEventHead = async () => testFeedCursor(committedTestEvents.length);
  host.deps.store.readWorkflowEventsAfter = async (after, { limit }) => {
    if (failTestFeedReads) throw new Error('event feed unavailable');
    const start = Number(after.slice('test:'.length));
    const page = committedTestEvents.slice(start, start + limit);
    return {
      events: page.map((event, index) => ({ cursor: testFeedCursor(start + index + 1), event })),
      next: testFeedCursor(start + page.length),
    };
  };
  host.deps.store.getRunAncestry = async id => {
    const parent = testRunParents.get(id);
    return parent === undefined ? [] : [{ id: parent } as WorkflowRun];
  };
  host.deps.loadConfig = coreCapabilities.loadConfig;
  host.deps.getUserAiPrefs = coreCapabilities.getUserAiPrefs;
  host.deps.isPerUserGitHubEnabled = coreCapabilities.isPerUserGitHubEnabled;
  host.deps.getUserGithubToken = async id =>
    (await coreCapabilities.getDecryptedAccessToken(id)) ?? undefined;
  host.operations = createSqlWorkflowOperations();
  return host;
}
