import { describe, expect, test } from 'bun:test';
import { getLatestWorkflowReference, resolveChatHeaderPath } from './chat-header';

describe('resolveChatHeaderPath', () => {
  test('prefers the cwd override over the workflow run path', () => {
    expect(resolveChatHeaderPath('/worktrees/parent', '/worktrees/detail', '/worktrees/run')).toBe(
      '/worktrees/detail'
    );
  });

  test('prefers the workflow run path over the conversation cwd', () => {
    expect(resolveChatHeaderPath('/worktrees/parent', null, '/worktrees/run')).toBe(
      '/worktrees/run'
    );
  });

  test('falls back to the conversation cwd when no override is available', () => {
    expect(resolveChatHeaderPath('/worktrees/parent', null)).toBe('/worktrees/parent');
    expect(resolveChatHeaderPath('/worktrees/parent', undefined)).toBe('/worktrees/parent');
  });

  test('ignores blank path candidates', () => {
    expect(resolveChatHeaderPath(' /worktrees/parent ', ' ', ' /worktrees/run ')).toBe(
      '/worktrees/run'
    );
    expect(resolveChatHeaderPath(' /worktrees/parent ', undefined, ' ')).toBe('/worktrees/parent');
    expect(resolveChatHeaderPath(' ', ' ', ' ')).toBeUndefined();
  });

  test('returns undefined when neither path is available', () => {
    expect(resolveChatHeaderPath(null, undefined)).toBeUndefined();
  });
});

describe('getLatestWorkflowReference', () => {
  test('selects the latest workflow result run id when present', () => {
    expect(
      getLatestWorkflowReference([
        {
          workflowResult: {
            workflowName: 'implement',
            runId: 'run-old',
          },
        },
        {},
        {
          workflowResult: {
            workflowName: 'review',
            runId: 'run-new',
          },
        },
      ])
    ).toEqual({ kind: 'result', runId: 'run-new' });
  });

  test('selects the latest workflow dispatch worker conversation id when no result exists', () => {
    expect(
      getLatestWorkflowReference([
        {
          workflowDispatch: {
            workflowName: 'implement',
            workerConversationId: 'worker-old',
          },
        },
        {
          workflowDispatch: {
            workflowName: 'review',
            workerConversationId: 'worker-new',
          },
        },
      ])
    ).toEqual({ kind: 'dispatch', workerConversationId: 'worker-new' });
  });

  test('prefers result over dispatch when both exist on the latest workflow message', () => {
    expect(
      getLatestWorkflowReference([
        {
          workflowDispatch: {
            workflowName: 'implement',
            workerConversationId: 'worker-old',
          },
        },
        {
          workflowDispatch: {
            workflowName: 'review',
            workerConversationId: 'worker-new',
          },
          workflowResult: {
            workflowName: 'review',
            runId: 'run-new',
          },
        },
      ])
    ).toEqual({ kind: 'result', runId: 'run-new' });
  });

  test('ignores blank workflow references', () => {
    expect(
      getLatestWorkflowReference([
        {
          workflowDispatch: {
            workflowName: 'implement',
            workerConversationId: ' ',
          },
          workflowResult: {
            workflowName: 'implement',
            runId: ' ',
          },
        },
      ])
    ).toBeUndefined();
  });
});
