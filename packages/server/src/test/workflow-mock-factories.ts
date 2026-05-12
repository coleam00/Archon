import type { Mock } from 'bun:test';
import { mock } from 'bun:test';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import type { ParseResult } from '@archon/workflows/loader';

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
} {
  return {
    isValidCommandName: mock(() => true),
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
