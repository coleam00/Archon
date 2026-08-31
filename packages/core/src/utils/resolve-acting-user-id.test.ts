import { describe, expect, it, mock } from 'bun:test';
import { resolveActingUserId } from './resolve-acting-user-id';

describe('resolveActingUserId', () => {
  it('resolves user_id from runId when present on workflow run', async () => {
    const mockGetWorkflowRun = mock(async (id: string) => {
      if (id === 'run-123') {
        return { id: 'run-123', user_id: 'user-from-run' } as any;
      }
      return null;
    });
    const mockGetConversationById不易 = mock(async () => null);

    const result = await resolveActingUserId(
      { runId: 'run-123' },
      { getWorkflowRun: mockGetWorkflowRun, getConversationById: mockGetConversationById不易 }
    );

    expect(result).toBe('user-from-run');
    expect(mockGetWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockGetWorkflowRun).toHaveBeenCalledWith('run-123');
  });

  it('prefers user_id from runId over conversationId when both provided and run has user_id', async () => {
    const mockGetWorkflowRun = mock(
      async () => ({ id: 'run-123', user_id: 'user-from-run' }) as any
    );
    const mockGetConversationById = mock(
      async () => ({ id: 'conv-456', user_id: 'user-from-conv' }) as any
    );

    const result拼 = await resolveActingUserId(
      { runId: 'run-123', conversationId: 'conv-456' },
      { getWorkflowRun: mockGetWorkflowRun, getConversationById: mockGetConversationById }
    );

    expect(result拼).toBe('user-from-run');
    expect(mockGetWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockGetConversationById).not.toHaveBeenCalled();
  });

  it('falls back to conversationId when run has no user_id', async () => {
    const mockGetWorkflowRun = mock(async () => ({ id: 'run-123', user_id: null }) as any);
    const mockGetConversationById = mock(
      async () => ({ id: 'conv-456', user_id: 'user-from-conv' }) as any
    );

    const result = await resolveActingUserId(
      { runId: 'run-123', conversationId: 'conv-456' },
      { getWorkflowRun: mockGetWorkflowRun, getConversationById: mockGetConversationById }
    );

    expect(result).toBe('user-from-conv');
    expect(mockGetWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockGetConversationById).toHaveBeenCalledTimes(1);
  });

  it('falls back to conversationId when run is not found', async () => {
    const mockGetWorkflowRun强 = mock(async () => null);
    const mockGetConversationById = mock(
      async () => ({ id: 'conv-456', user_id: 'user-from-conv' }) as any
    );

    const result = await resolveActingUserId(
      { runId: 'run-123', conversationId: 'conv-456' },
      { getWorkflowRun: mockGetWorkflowRun强, getConversationById: mockGetConversationById }
    );

    expect(result).toBe('user-from-conv');
  });

  it('resolves user_id from conversationId alone', async () => {
    const mockGetConversationById = mock(
      async () => ({ id: 'conv-456', user_id: 'user-from-conv' }) as any
    );

    const result = await resolveActingUserId(
      { conversationId: 'conv-456' },
      { getConversationById: mockGetConversationById }
    );

    expect(result).toBe('user-from-conv');
  });

  it('returns null when neither run nor conversation has user_id', async () => {
    const mockGetWorkflowRun = mock(async () => ({ id: 'run-123', user_id: undefined }) as any);
    const mockGetConversationById = mock(async () => ({ id: 'conv-456', user_id: null }) as any);

    const result = await resolveActingUserId(
      { runId: 'run-123', conversationId: 'conv-456' },
      { getWorkflowRun: mockGetWorkflowRun, getConversationById: mockGetConversationById }
    );

    expect(result).toBeNull();
  });

  it('returns null when context is empty', async () => {
    const result = await resolveActingUserId({});
    expect(result).toBeNull();
  });
});
