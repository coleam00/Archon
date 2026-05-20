import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';

const invalidateQueriesMock = mock(async () => undefined);
const navigateMock = mock((): void => undefined);

const useQueryMock = mock(
  (options: {
    queryKey: readonly unknown[];
    refetchInterval?: (query: { state: { data?: unknown } }) => number | false;
  }) => {
    if (options.queryKey[0] === 'workflowRun') {
      expect(() => options.refetchInterval?.({ state: { data: {} } })).not.toThrow();
      return {
        data: {
          events: [],
          workerPlatformId: null,
          parentPlatformId: null,
          conversationPlatformId: null,
          codebaseId: null,
        },
        error: null,
      };
    }

    return { data: undefined, error: null };
  }
);

mock.module('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
  useQueryClient: (): { invalidateQueries: typeof invalidateQueriesMock } => ({
    invalidateQueries: invalidateQueriesMock,
  }),
}));

mock.module('react-router', () => ({
  useNavigate: (): typeof navigateMock => navigateMock,
}));

mock.module('@/stores/workflow-store', () => ({
  useWorkflowStore: (selector: (state: { workflows: Map<string, unknown> }) => unknown): unknown =>
    selector({ workflows: new Map() }),
}));

mock.module('@/lib/api', () => ({
  getWorkflowRun: mock(async (): Promise<{ run: null; events: [] }> => ({ run: null, events: [] })),
  getWorkflowRunByWorker: mock(async (): Promise<null> => null),
  getCodebase: mock(async (): Promise<null> => null),
  getWorkflow: mock(async (): Promise<null> => null),
}));

mock.module('./DagNodeProgress', () => ({
  DagNodeProgress: (): ReactElement => <div data-testid="dag-node-progress" />,
}));

mock.module('./StepLogs', () => ({
  StepLogs: (): ReactElement => <div data-testid="step-logs" />,
}));

mock.module('./WorkflowLogs', () => ({
  WorkflowLogs: (): ReactElement => <div data-testid="workflow-logs" />,
}));

mock.module('./WorkflowDagViewer', () => ({
  WorkflowDagViewer: (): ReactElement => <div data-testid="workflow-dag-viewer" />,
}));

mock.module('./ArtifactSummary', () => ({
  ArtifactSummary: (): ReactElement => <div data-testid="artifact-summary" />,
}));

mock.module('@/components/chat/ChatInterface', () => ({
  ChatInterface: (): ReactElement => <div data-testid="chat-interface" />,
}));

mock.module('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children?: ReactNode }): ReactElement => <div>{children}</div>,
  TabsList: ({ children }: { children?: ReactNode }): ReactElement => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }): ReactElement => (
    <button>{children}</button>
  ),
}));

mock.module('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }): ReactElement => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }): ReactElement => <div>{children}</div>,
  ResizableHandle: (): ReactElement => <div />,
}));

describe('WorkflowExecution', () => {
  beforeEach(() => {
    useQueryMock.mockClear();
    invalidateQueriesMock.mockClear();
  });

  it('renders loading state when workflowState is missing from partial query data', async () => {
    const workflowExecutionModule = await import('./WorkflowExecution');

    const html = renderToString(
      createElement(workflowExecutionModule.WorkflowExecution, { runId: 'run-1' })
    );

    expect(html).toContain('Loading workflow execution');
    expect(useQueryMock).toHaveBeenCalled();
  });
});
