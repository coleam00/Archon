import type { Mock } from 'bun:test';
import { mock } from 'bun:test';
import type { ConversationLockManager } from '@archon/core';
import type { DashboardRunsResult } from '@archon/core/db/workflows';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import type { ParseResult } from '@archon/workflows/loader';

type ListDashboardRuns = (typeof import('@archon/core/db/workflows'))['listDashboardRuns'];

interface DashboardRunsOverrides {
  runs?: DashboardRunsResult['runs'];
  total?: number;
  counts?: Partial<DashboardRunsResult['counts']>;
}

export function makeDashboardRunsResult({
  runs = [],
  total = runs.length,
  counts = {},
}: DashboardRunsOverrides = {}): DashboardRunsResult {
  return {
    runs,
    total,
    counts: {
      all: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pending: 0,
      paused: 0,
      ...counts,
    },
  };
}

export function makeListDashboardRunsMock(): Mock<ListDashboardRuns> {
  return mock<ListDashboardRuns>(async () => makeDashboardRunsResult());
}

/**
 * Register all 4 @archon/workflows mock.module() calls at once.
 * Must be called before importing the module under test.
 */
export function mockAllWorkflowModules(): void {
  mock.module('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
  mock.module('@archon/workflows/loader', makeLoaderMock);
  mock.module('@archon/workflows/command-validation', makeCommandValidationMock);
  mock.module('@archon/workflows/defaults', makeDefaultsMock);
}

export function makeDiscoverWorkflowsMock(): {
  discoverWorkflowsWithConfig: Mock<() => Promise<WorkflowLoadResult>>;
} {
  return {
    discoverWorkflowsWithConfig: mock(
      async (): Promise<WorkflowLoadResult> => ({ workflows: [], errors: [] })
    ),
  };
}

export function makeLoaderMock(): {
  parseWorkflow: Mock<() => ParseResult>;
} {
  return {
    parseWorkflow: mock(
      (): ParseResult => ({
        workflow: null,
        error: { filename: '', error: 'stub', errorType: 'parse_error' },
      })
    ),
  };
}

/**
 * Stub that always returns true. Tests relying on actual name validation
 * (path traversal, dot-prefix) should use their own inline mock instead.
 */
export function makeCommandValidationMock(): {
  isValidCommandName: Mock<() => boolean>;
  isValidWorkflowName: Mock<() => boolean>;
} {
  return {
    isValidCommandName: mock(() => true),
    isValidWorkflowName: mock(() => true),
  };
}

export function makeDefaultsMock(): {
  BUNDLED_WORKFLOWS: Record<string, string>;
  BUNDLED_COMMANDS: Record<string, string>;
  isBinaryBuild: Mock<() => boolean>;
} {
  return {
    BUNDLED_WORKFLOWS: {},
    BUNDLED_COMMANDS: {},
    isBinaryBuild: mock(() => false),
  };
}

/**
 * A lock manager that admits everything, for route tests that are not about
 * admission. One definition rather than a copy per test file: `registerApiRoutes`
 * takes the real class, so every duck-typed copy has to grow each member the routes
 * start calling, and a copy that misses one fails at runtime with a bare TypeError.
 *
 * Override the members a test is actually about — `isDraining` for drain refusal,
 * `getStats`/`getDrainStatus` for what health reports.
 */
export function makeMockLockManager(
  overrides: Partial<ConversationLockManager> = {}
): ConversationLockManager {
  const members: Partial<ConversationLockManager> = {
    getStats: mock(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    })),
    beginDrain: mock(() => {
      throw new Error('makeMockLockManager: beginDrain is not stubbed');
    }),
    cancelDrain: mock(() => {}),
    getDrainStatus: mock(() => undefined),
    isDraining: mock(() => false),
    ...overrides,
  };
  return {
    // Default admission follows `isDraining`, as the real manager does, so stubbing
    // drain alone cannot produce a manager that claims to be draining and admits
    // work anyway — a test built on that pair would prove nothing.
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      if (members.isDraining?.()) return { status: 'refused-draining' };
      await fn();
      return { status: 'started' };
    }),
    ...members,
  } as unknown as ConversationLockManager;
}
