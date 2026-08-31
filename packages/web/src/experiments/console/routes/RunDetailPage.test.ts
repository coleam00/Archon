import { describe, it, expect } from 'bun:test';
import { resolveRunOrchestratorConversationId } from './RunDetailPage';

describe('resolveRunOrchestratorConversationId', () => {
  it('should return null when run is null or undefined', () => {
    expect(resolveRunOrchestratorConversationId(null)).toBeNull();
    expect(resolveRunOrchestratorConversationId(undefined)).toBeNull();
  });

  it('should resolve parentPlatformId with highest priority', () => {
    const run = {
      parentPlatformId: 'parent-platform-1',
      parent_platform_id: 'parent-platform-2',
      metadata: { parent_platform_id: 'meta-platform-1' },
      conversationPlatformId: 'cli-platform-1',
    };
    expect(resolveRunOrchestratorConversationId(run as any)).toBe('parent-platform-1');
  });

  it('should fall back to parent_platform_id when parentPlatformId is absent', () => {
    const run = {
      parent_platform_id: 'parent-platform-2',
      conversationPlatformId: 'cli-platform-1',
    };
    expect(resolveRunOrchestratorConversationId(run as any)).toBe('parent-platform-2');
  });

  it('should not resolve database UUID parentConversationId or sourceConversationId', () => {
    const run = {
      id: 'run-1',
      parentConversationId: 'parent-db-uuid-1',
      sourceConversationId: 'source-db-uuid-1',
    };
    expect(resolveRunOrchestratorConversationId(run as any)).toBeNull();
  });

  it('should fall back to metadata platform ID fields in priority order', () => {
    const runMeta1 = {
      metadata: {
        parent_platform_id: 'meta-parent-plat-1',
        parentPlatformId: 'meta-parent-plat-2',
      },
    };
    expect(resolveRunOrchestratorConversationId(runMeta1 as any)).toBe('meta-parent-plat-1');

    const runMeta2 = {
      metadata: {
        parentPlatformId: 'meta-parent-plat-2',
        dispatch_platform_id: 'meta-dispatch-plat-1',
      },
    };
    expect(resolveRunOrchestratorConversationId(runMeta2 as any)).toBe('meta-parent-plat-2');

    const runMeta3 = {
      metadata: {
        dispatch_platform_id: 'meta-dispatch-plat-1',
        dispatchPlatformId: 'meta-dispatch-plat-2',
      },
    };
    expect(resolveRunOrchestratorConversationId(runMeta3 as any)).toBe('meta-dispatch-plat-1');

    const runMeta4 = {
      metadata: {
        dispatchPlatformId: 'meta-dispatch-plat-2',
      },
    };
    expect(resolveRunOrchestratorConversationId(runMeta4 as any)).toBe('meta-dispatch-plat-2');
  });

  it('should fall back to conversationPlatformId and conversation_platform_id for CLI / direct runs', () => {
    const run1 = {
      conversationPlatformId: 'conv-platform-1',
      conversation_platform_id: 'conv-platform-2',
    };
    expect(resolveRunOrchestratorConversationId(run1 as any)).toBe('conv-platform-1');

    const run2 = {
      conversation_platform_id: 'conv-platform-2',
    };
    expect(resolveRunOrchestratorConversationId(run2 as any)).toBe('conv-platform-2');
  });

  it('should fall back to workerPlatformId when CLI conversation is not present', () => {
    const run1 = {
      workerPlatformId: 'worker-platform-1',
      worker_platform_id: 'worker-platform-2',
    };
    expect(resolveRunOrchestratorConversationId(run1 as any)).toBe('worker-platform-1');

    const run2 = {
      worker_platform_id: 'worker-platform-2',
    };
    expect(resolveRunOrchestratorConversationId(run2 as any)).toBe('worker-platform-2');
  });

  it('should return null when run has no matching conversation platform properties', () => {
    const run = {
      id: 'run-1',
      metadata: {
        parent_conversation_id: 'db-uuid-1',
      },
    };
    expect(resolveRunOrchestratorConversationId(run as any)).toBeNull();
  });
});
