import { ConversationLockManager } from './conversation-lock';

describe('ConversationLockManager', () => {
  test('initializes with correct maxConcurrent', () => {
    const manager = new ConversationLockManager(5);
    const stats = manager.getStats();
    expect(stats.maxConcurrent).toBe(5);
    expect(stats.active).toBe(0);
    expect(stats.queuedTotal).toBe(0);
  });

  test('getStats returns empty state initially', () => {
    const manager = new ConversationLockManager(10);
    const stats = manager.getStats();
    expect(stats).toEqual({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    });
  });

  test('processes handler immediately when under capacity', async () => {
    const manager = new ConversationLockManager(10);
    let executed = false;

    await manager.acquireLock('test-1', async () => {
      executed = true;
    });

    // Small delay to allow async completion
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(executed).toBe(true);
    expect(manager.getStats().active).toBe(0); // Should be completed
  });

  test('queues message when same conversation already active', async () => {
    const manager = new ConversationLockManager(10);
    const executionOrder: number[] = [];

    // Start first message (will block for 50ms)
    manager.acquireLock('same-conv', async () => {
      executionOrder.push(1);
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // Small delay to ensure first handler is started
    await new Promise(resolve => setTimeout(resolve, 10));

    // Start second message (should queue)
    manager.acquireLock('same-conv', async () => {
      executionOrder.push(2);
    });

    // Check stats immediately
    const stats = manager.getStats();
    expect(stats.active).toBe(1);
    expect(stats.queuedTotal).toBe(1);
    expect(stats.queuedByConversation).toEqual([
      { conversationId: 'same-conv', queuedMessages: 1 },
    ]);

    // Wait for both to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(executionOrder).toEqual([1, 2]); // Should execute in order
    expect(manager.getStats().active).toBe(0);
    expect(manager.getStats().queuedTotal).toBe(0);
  });

  test('queues message when at max capacity', async () => {
    const manager = new ConversationLockManager(2);

    // Start 2 conversations (fills capacity)
    manager.acquireLock('conv-1', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    manager.acquireLock('conv-2', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // Small delay to ensure both started
    await new Promise(resolve => setTimeout(resolve, 10));

    // Try to start third (should queue)
    manager.acquireLock('conv-3', async () => {
      // This should execute eventually
    });

    const stats = manager.getStats();
    expect(stats.active).toBe(2); // At capacity
    expect(stats.queuedTotal).toBe(1); // One queued

    // Wait for completion (need longer to process queued item)
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(manager.getStats().active).toBe(0);
    expect(manager.getStats().queuedTotal).toBe(0);
  });

  test('multiple conversations process concurrently', async () => {
    const manager = new ConversationLockManager(10);
    const startTimes: Record<string, number> = {};

    // Start 3 conversations simultaneously
    const promises = [1, 2, 3].map(i =>
      manager.acquireLock(`conv-${i}`, async () => {
        startTimes[`conv-${i}`] = Date.now();
        await new Promise(resolve => setTimeout(resolve, 30));
      })
    );

    await Promise.all(promises);

    // Small delay to allow all to start
    await new Promise(resolve => setTimeout(resolve, 20));

    // All should have started around the same time (concurrent)
    const times = Object.values(startTimes);
    expect(times.length).toBe(3);
    const maxDiff = Math.max(...times) - Math.min(...times);
    expect(maxDiff).toBeLessThan(20); // Started within 20ms of each other

    // Wait for completion
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test('queued messages process in order after completion', async () => {
    const manager = new ConversationLockManager(10);
    const executionOrder: number[] = [];

    // Start first message
    manager.acquireLock('test-conv', async () => {
      executionOrder.push(1);
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 10));

    // Queue second and third messages
    manager.acquireLock('test-conv', async () => {
      executionOrder.push(2);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    manager.acquireLock('test-conv', async () => {
      executionOrder.push(3);
    });

    // Wait for all to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(executionOrder).toEqual([1, 2, 3]); // FIFO order
  });

  test('error in handler does not prevent queue processing', async () => {
    const manager = new ConversationLockManager(10);
    const executionOrder: number[] = [];

    // First message throws error
    manager.acquireLock('test-conv', async () => {
      executionOrder.push(1);
      throw new Error('Test error');
    });

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second message should still execute
    manager.acquireLock('test-conv', async () => {
      executionOrder.push(2);
    });

    // Wait for completion
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(executionOrder).toEqual([1, 2]); // Second still executes
    expect(manager.getStats().active).toBe(0); // Cleaned up properly
  });

  test('stats show correct active conversation IDs', async () => {
    const manager = new ConversationLockManager(10);

    // Start 2 conversations
    manager.acquireLock('conv-a', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    manager.acquireLock('conv-b', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 10));

    const stats = manager.getStats();
    expect(stats.activeConversationIds).toContain('conv-a');
    expect(stats.activeConversationIds).toContain('conv-b');
    expect(stats.activeConversationIds.length).toBe(2);

    // Wait for completion
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});
