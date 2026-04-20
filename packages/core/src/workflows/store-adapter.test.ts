import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { IWorkflowStore } from '@archon/workflows/store';
import * as dbWorkflows from '../db/workflows';
import * as dbWorkflowEvents from '../db/workflow-events';
import * as dbCodebases from '../db/codebases';
import * as configLoader from '../config/config-loader';

// Mock DB modules before importing store-adapter
const mockCreateWorkflowRun = mock(() => Promise.resolve({ id: 'run-1' }));
const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockGetActiveWorkflowRunByPath = mock(() => Promise.resolve(null));
const mockFailOrphanedRuns = mock(() => Promise.resolve({ count: 0 }));
const mockFindResumableRun = mock(() => Promise.resolve(null));
const mockResumeWorkflowRun = mock(() => Promise.resolve({ id: 'run-1' }));
const mockUpdateWorkflowRun = mock(() => Promise.resolve());
const mockUpdateWorkflowActivity = mock(() => Promise.resolve());
const mockGetWorkflowRunStatus = mock(() => Promise.resolve('running'));
const mockCompleteWorkflowRun = mock(() => Promise.resolve());
const mockFailWorkflowRun = mock(() => Promise.resolve());
const mockCancelWorkflowRun = mock(() => Promise.resolve());
const mockPauseWorkflowRun = mock(() => Promise.resolve());

const mockCreateWorkflowEvent = mock(() => Promise.resolve());
const mockGetCompletedDagNodeOutputs = mock(() => Promise.resolve(new Map<string, string>()));

const mockGetCodebase = mock(() => Promise.resolve(null));

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => ({})),
}));

// Spy variable declarations
let spyDbWorkflowsCreateRun: ReturnType<typeof spyOn>;
let spyDbWorkflowsGetRun: ReturnType<typeof spyOn>;
let spyDbWorkflowsGetActiveByPath: ReturnType<typeof spyOn>;
let spyDbWorkflowsFailOrphaned: ReturnType<typeof spyOn>;
let spyDbWorkflowsFindResumable: ReturnType<typeof spyOn>;
let spyDbWorkflowsResumeRun: ReturnType<typeof spyOn>;
let spyDbWorkflowsUpdateRun: ReturnType<typeof spyOn>;
let spyDbWorkflowsUpdateActivity: ReturnType<typeof spyOn>;
let spyDbWorkflowsGetStatus: ReturnType<typeof spyOn>;
let spyDbWorkflowsCompleteRun: ReturnType<typeof spyOn>;
let spyDbWorkflowsFailRun: ReturnType<typeof spyOn>;
let spyDbWorkflowsCancelRun: ReturnType<typeof spyOn>;
let spyDbWorkflowsPauseRun: ReturnType<typeof spyOn>;
let spyDbWorkflowEventsCreate: ReturnType<typeof spyOn>;
let spyDbWorkflowEventsGetOutputs: ReturnType<typeof spyOn>;
let spyDbCodebasesGet: ReturnType<typeof spyOn>;
let spyConfigLoaderLoad: ReturnType<typeof spyOn>;

const { createWorkflowStore, createWorkflowDeps } = await import('./store-adapter');

beforeEach(() => {
  spyDbWorkflowsCreateRun = spyOn(dbWorkflows, 'createWorkflowRun').mockImplementation(
    mockCreateWorkflowRun
  );
  spyDbWorkflowsGetRun = spyOn(dbWorkflows, 'getWorkflowRun').mockImplementation(
    mockGetWorkflowRun
  );
  spyDbWorkflowsGetActiveByPath = spyOn(
    dbWorkflows,
    'getActiveWorkflowRunByPath'
  ).mockImplementation(mockGetActiveWorkflowRunByPath);
  spyDbWorkflowsFailOrphaned = spyOn(dbWorkflows, 'failOrphanedRuns').mockImplementation(
    mockFailOrphanedRuns
  );
  spyDbWorkflowsFindResumable = spyOn(dbWorkflows, 'findResumableRun').mockImplementation(
    mockFindResumableRun
  );
  spyDbWorkflowsResumeRun = spyOn(dbWorkflows, 'resumeWorkflowRun').mockImplementation(
    mockResumeWorkflowRun
  );
  spyDbWorkflowsUpdateRun = spyOn(dbWorkflows, 'updateWorkflowRun').mockImplementation(
    mockUpdateWorkflowRun
  );
  spyDbWorkflowsUpdateActivity = spyOn(dbWorkflows, 'updateWorkflowActivity').mockImplementation(
    mockUpdateWorkflowActivity
  );
  spyDbWorkflowsGetStatus = spyOn(dbWorkflows, 'getWorkflowRunStatus').mockImplementation(
    mockGetWorkflowRunStatus
  );
  spyDbWorkflowsCompleteRun = spyOn(dbWorkflows, 'completeWorkflowRun').mockImplementation(
    mockCompleteWorkflowRun
  );
  spyDbWorkflowsFailRun = spyOn(dbWorkflows, 'failWorkflowRun').mockImplementation(
    mockFailWorkflowRun
  );
  spyDbWorkflowsCancelRun = spyOn(dbWorkflows, 'cancelWorkflowRun').mockImplementation(
    mockCancelWorkflowRun
  );
  spyDbWorkflowsPauseRun = spyOn(dbWorkflows, 'pauseWorkflowRun').mockImplementation(
    mockPauseWorkflowRun
  );
  spyDbWorkflowEventsCreate = spyOn(dbWorkflowEvents, 'createWorkflowEvent').mockImplementation(
    mockCreateWorkflowEvent
  );
  spyDbWorkflowEventsGetOutputs = spyOn(
    dbWorkflowEvents,
    'getCompletedDagNodeOutputs'
  ).mockImplementation(mockGetCompletedDagNodeOutputs);
  spyDbCodebasesGet = spyOn(dbCodebases, 'getCodebase').mockImplementation(mockGetCodebase);
  spyConfigLoaderLoad = spyOn(configLoader, 'loadConfig').mockImplementation(
    mock(() => Promise.resolve({ assistant: 'claude' }))
  );
});

afterEach(() => {
  spyDbWorkflowsCreateRun.mockRestore();
  spyDbWorkflowsGetRun.mockRestore();
  spyDbWorkflowsGetActiveByPath.mockRestore();
  spyDbWorkflowsFailOrphaned.mockRestore();
  spyDbWorkflowsFindResumable.mockRestore();
  spyDbWorkflowsResumeRun.mockRestore();
  spyDbWorkflowsUpdateRun.mockRestore();
  spyDbWorkflowsUpdateActivity.mockRestore();
  spyDbWorkflowsGetStatus.mockRestore();
  spyDbWorkflowsCompleteRun.mockRestore();
  spyDbWorkflowsFailRun.mockRestore();
  spyDbWorkflowsCancelRun.mockRestore();
  spyDbWorkflowsPauseRun.mockRestore();
  spyDbWorkflowEventsCreate.mockRestore();
  spyDbWorkflowEventsGetOutputs.mockRestore();
  spyDbCodebasesGet.mockRestore();
  spyConfigLoaderLoad.mockRestore();
});

describe('createWorkflowStore', () => {
  test('returns object with all IWorkflowStore methods', () => {
    const store = createWorkflowStore();
    const requiredMethods: (keyof IWorkflowStore)[] = [
      'createWorkflowRun',
      'getWorkflowRun',
      'getActiveWorkflowRunByPath',
      'failOrphanedRuns',
      'findResumableRun',
      'resumeWorkflowRun',
      'updateWorkflowRun',
      'updateWorkflowActivity',
      'getWorkflowRunStatus',
      'completeWorkflowRun',
      'failWorkflowRun',
      'pauseWorkflowRun',
      'cancelWorkflowRun',
      'createWorkflowEvent',
      'getCompletedDagNodeOutputs',
      'getCodebase',
      'getCodebaseEnvVars',
    ];
    for (const method of requiredMethods) {
      expect(typeof store[method]).toBe('function');
    }
  });

  test('delegates getWorkflowRunStatus to DB and returns typed status', async () => {
    mockGetWorkflowRunStatus.mockResolvedValueOnce('completed');
    const store = createWorkflowStore();
    const result = await store.getWorkflowRunStatus('run-123');
    expect(result).toBe('completed');
    expect(mockGetWorkflowRunStatus).toHaveBeenCalledWith('run-123');
  });

  test('delegates getWorkflowRunStatus returns null for missing run', async () => {
    mockGetWorkflowRunStatus.mockResolvedValueOnce(null);
    const store = createWorkflowStore();
    const result = await store.getWorkflowRunStatus('nonexistent');
    expect(result).toBeNull();
  });

  test('createWorkflowEvent catches and logs unexpected throws', async () => {
    mockCreateWorkflowEvent.mockRejectedValueOnce(new Error('DB connection lost'));
    const store = createWorkflowStore();
    // Should not throw — the wrapper guarantees the non-throwing contract
    await expect(
      store.createWorkflowEvent({
        workflow_run_id: 'run-1',
        event_type: 'step_started',
        step_index: 0,
        step_name: 'test-step',
      })
    ).resolves.toBeUndefined();
  });

  test('delegates getCompletedDagNodeOutputs to DB', async () => {
    const expected = new Map([['step1', 'output text']]);
    mockGetCompletedDagNodeOutputs.mockResolvedValueOnce(expected);
    const store = createWorkflowStore();
    const result = await store.getCompletedDagNodeOutputs('run-123');
    expect(result).toBe(expected);
    expect(mockGetCompletedDagNodeOutputs).toHaveBeenCalledWith('run-123');
  });

  test('delegates cancelWorkflowRun to DB', async () => {
    mockCancelWorkflowRun.mockResolvedValueOnce(undefined);
    const store = createWorkflowStore();
    await store.cancelWorkflowRun('run-123');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-123');
  });

  test('delegates getCodebase to DB', async () => {
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-1',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/workspace/repo',
    });
    const store = createWorkflowStore();
    const result = await store.getCodebase('cb-1');
    expect(result).toEqual({
      id: 'cb-1',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/workspace/repo',
    });
  });
});

describe('createWorkflowDeps', () => {
  test('returns WorkflowDeps with store, getAgentProvider, and loadConfig', () => {
    const deps = createWorkflowDeps();
    expect(deps.store).toBeDefined();
    expect(typeof deps.getAgentProvider).toBe('function');
    expect(typeof deps.loadConfig).toBe('function');
  });

  test('store from createWorkflowDeps has all IWorkflowStore methods', () => {
    const deps = createWorkflowDeps();
    expect(typeof deps.store.createWorkflowRun).toBe('function');
    expect(typeof deps.store.getWorkflowRun).toBe('function');
    expect(typeof deps.store.createWorkflowEvent).toBe('function');
    expect(typeof deps.store.getCodebase).toBe('function');
  });
});
