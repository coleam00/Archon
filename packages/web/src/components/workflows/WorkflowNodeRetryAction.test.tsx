import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkflowNodeRetryAction } from './WorkflowNodeRetryAction';
import type { DagNodeState, WorkflowRunStatus } from '@/lib/types';

interface RenderRetryActionOptions {
  node: DagNodeState | null;
  runId?: string;
  runStatus?: WorkflowRunStatus;
  parentPlatformId?: string | null;
  conversationPlatformId?: string | null;
}

function renderRetryAction({
  node,
  runId = 'run-123',
  runStatus = 'failed',
  parentPlatformId = 'web-parent',
  conversationPlatformId = 'web-conversation',
}: RenderRetryActionOptions): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const markup = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <WorkflowNodeRetryAction
        runId={runId}
        runStatus={runStatus}
        node={node}
        parentPlatformId={parentPlatformId}
        conversationPlatformId={conversationPlatformId}
      />
    </QueryClientProvider>
  );

  queryClient.clear();
  return markup;
}

function failedNode(overrides: Partial<DagNodeState> = {}): DagNodeState {
  return {
    nodeId: 'build',
    name: 'Build',
    status: 'failed',
    error: 'Build failed',
    ...overrides,
  };
}

function routeLoopNode(overrides: Partial<DagNodeState> = {}): DagNodeState {
  return {
    nodeId: 'review-router',
    name: 'Review Router',
    status: 'completed',
    routeDecision: {
      from: 'review',
      outcome: 'negative',
      to: 'fix',
      condition: "$review.output.approved == '<redacted>'",
      condition_result: false,
      negative_count: 1,
      max_iterations: 2,
      attempt: 1,
      execution_seq: 4,
    },
    ...overrides,
  };
}

describe('WorkflowNodeRetryAction', () => {
  test('renders a retry action for an eligible failed node', () => {
    const markup = renderRetryAction({ node: failedNode() });

    expect(markup).toContain('Failed node: Build');
    expect(markup).toContain('Retry selected node and descendants');
    expect(markup).toContain('Retry');
  });

  test('renders a retry action for a failed node in a cancelled run', () => {
    const markup = renderRetryAction({ node: failedNode(), runStatus: 'cancelled' });

    expect(markup).toContain('Failed node: Build');
    expect(markup).toContain('Retry');
  });

  test('guides route-loop controllers toward route_loop.from instead of direct retry', () => {
    const markup = renderRetryAction({ node: routeLoopNode() });

    expect(markup).toContain('Retry the route source node');
    expect(markup).toContain('route_loop.from');
    expect(markup).toContain('review');
    expect(markup).not.toContain('Failed node: Review Router');
    expect(markup).not.toContain('Retry selected node and descendants');
    expect(markup).not.toContain('<button');
  });

  test('shows the route_loop.from CLI retry command for CLI-created runs', () => {
    const markup = renderRetryAction({
      node: routeLoopNode(),
      parentPlatformId: null,
      conversationPlatformId: 'cli-conversation',
    });

    expect(markup).toContain('Retry the route source node');
    expect(markup).toContain('archon workflow retry-node run-123 review');
    expect(markup).not.toContain('archon workflow retry-node run-123 review-router');
  });

  test('hides route-loop guidance outside retryable runs', () => {
    const markup = renderRetryAction({
      node: routeLoopNode(),
      runStatus: 'completed',
    });

    expect(markup).toBe('');
  });
});
