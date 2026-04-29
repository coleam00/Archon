import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import type { IWorkflowStore } from '@archon/workflows/store';

// Import modules to spy on BEFORE importing module under test
import * as dbWorkflows from '../db/workflows';
import * as dbWorkflowEvents from '../db/workflow-events';
import * as dbCodebases from '../db/codebases';
import * as providers from '@archon/providers';
import * as configLoader from '../config/config-loader';

import { createWorkflowStore, createWorkflowDeps } from './store-adapter';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetActiveWorkflowRunByPath: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyFailOrphanedRuns: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyFindResumableRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyResumeWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyUpdateWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyUpdateWorkflowActivity: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetWorkflowRunStatus: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCompleteWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyFailWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCancelWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyPauseWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateWorkflowEvent: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetCompletedDagNodeOutputs: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetCodebase: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetAgentProvider: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyLoadConfig: any;

beforeEach(() => {
  spyCreateWorkflowRun = spyOn(dbWorkflows, 'createWorkflowRun').mockResolvedValue({
    id: 'run-1',
  } as never);
  spyGetWorkflowRun = spyOn(dbWorkflows, 'getWorkflowRun').mockResolvedValue(null);
  spyGetActiveWorkflowRunByPath = spyOn(
    dbWorkflows,
    'getActiveWorkflowRunByPath'
  ).mockResolvedValue(null);
  spyFailOrphanedRuns = spyOn(dbWorkflows, 'failOrphanedRuns').mockResolvedValue({ count: 0 });
  spyFindResumableRun = spyOn(dbWorkflows, 'findResumableRun').mockResolvedValue(null);
  spyResumeWorkflowRun = spyOn(dbWorkflows, 'resumeWorkflowRun').mockResolvedValue({
    id: 'run-1',
  } as never);
  spyUpdateWorkflowRun = spyOn(dbWorkflows, 'updateWorkflowRun').mockResolvedValue(undefined);
  spyUpdateWorkflowActivity = spyOn(dbWorkflows, 'updateWorkflowActivity').mockResolvedValue(
    undefined
  );
  spyGetWorkflowRunStatus = spyOn(dbWorkflows, 'getWorkflowRunStatus').mockResolvedValue(
    'running' as never
  );
  spyCompleteWorkflowRun = spyOn(dbWorkflows, 'completeWorkflowRun').mockResolvedValue(undefined);
  spyFailWorkflowRun = spyOn(dbWorkflows, 'failWorkflowRun').mockResolvedValue(undefined);
  spyCancelWorkflowRun = spyOn(dbWorkflows, 'cancelWorkflowRun').mockResolvedValue(undefined);
  spyPauseWorkflowRun = spyOn(dbWorkflows, 'pauseWorkflowRun').mockResolvedValue(undefined);
  spyCreateWorkflowEvent = spyOn(dbWorkflowEvents, 'createWorkflowEvent').mockResolvedValue(
    undefined
  );
  spyGetCompletedDagNodeOutputs = spyOn(
    dbWorkflowEvents,
    'getCompletedDagNodeOutputs'
  ).mockResolvedValue(new Map<string, string>());
  spyGetCodebase = spyOn(dbCodebases, 'getCodebase').mockResolvedValue(null);
  spyGetAgentProvider = spyOn(providers, 'getAgentProvider').mockReturnValue({} as never);
  spyLoadConfig = spyOn(configLoader, 'loadConfig').mockResolvedValue({
    assistant: 'claude',
  } as never);
});

afterEach(() => {
  spyCreateWorkflowRun.mockRestore();
  spyGetWorkflowRun.mockRestore();
  spyGetActiveWorkflowRunByPath.mockRestore();
  spyFailOrphanedRuns.mockRestore();
  spyFindResumableRun.mockRestore();
  spyResumeWorkflowRun.mockRestore();
  spyUpdateWorkflowRun.mockRestore();
  spyUpdateWorkflowActivity.mockRestore();
  spyGetWorkflowRunStatus.mockRestore();
  spyCompleteWorkflowRun.mockRestore();
  spyFailWorkflowRun.mockRestore();
  spyCancelWorkflowRun.mockRestore();
  spyPauseWorkflowRun.mockRestore();
  spyCreateWorkflowEvent.mockRestore();
  spyGetCompletedDagNodeOutputs.mockRestore();
  spyGetCodebase.mockRestore();
  spyGetAgentProvider.mockRestore();
  spyLoadConfig.mockRestore();
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
    spyGetWorkflowRunStatus.mockResolvedValueOnce('completed');
    const store = createWorkflowStore();
    const result = await store.getWorkflowRunStatus('run-123');
    expect(result).toBe('completed');
    expect(spyGetWorkflowRunStatus).toHaveBeenCalledWith('run-123');
  });

  test('delegates getWorkflowRunStatus returns null for missing run', async () => {
    spyGetWorkflowRunStatus.mockResolvedValueOnce(null);
    const store = createWorkflowStore();
    const result = await store.getWorkflowRunStatus('nonexistent');
    expect(result).toBeNull();
  });

  test('createWorkflowEvent catches and logs unexpected throws', async () => {
    spyCreateWorkflowEvent.mockRejectedValueOnce(new Error('DB connection lost'));
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
    spyGetCompletedDagNodeOutputs.mockResolvedValueOnce(expected);
    const store = createWorkflowStore();
    const result = await store.getCompletedDagNodeOutputs('run-123');
    expect(result).toBe(expected);
    expect(spyGetCompletedDagNodeOutputs).toHaveBeenCalledWith('run-123');
  });

  test('delegates cancelWorkflowRun to DB', async () => {
    spyCancelWorkflowRun.mockResolvedValueOnce(undefined);
    const store = createWorkflowStore();
    await store.cancelWorkflowRun('run-123');
    expect(spyCancelWorkflowRun).toHaveBeenCalledWith('run-123');
  });

  test('delegates getCodebase to DB', async () => {
    spyGetCodebase.mockResolvedValueOnce({
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
