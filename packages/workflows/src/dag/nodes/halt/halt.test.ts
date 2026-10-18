// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, type Mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';

describe('executeDagWorkflow -- cancel node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-cancel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('cancel node transitions run to cancelled and sends message', async () => {
    const store = createMockStore();
    store.cancelWorkflowRun.mockResolvedValue({ cancelled: true });
    // Track whether cancelWorkflowRun has been called to simulate status transition
    let cancelled = false;
    store.cancelWorkflowRun.mockImplementation(async _id => {
      expect(
        store.persistWorkflowEvent.mock.calls
          .map(([event]) => event)
          .filter(event => event.step_name === 'stop')
          .map(event => event.event_type)
      ).toEqual(['node_started']);
      cancelled = true;
      return { cancelled: true };
    });
    (store.getWorkflowRunStatus as Mock<() => Promise<string>>).mockImplementation(async () =>
      cancelled ? 'cancelled' : 'running'
    );
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'cancel-test',
          nodes: [
            { id: 'check', kind: 'exec', runtime: 'sh', script: 'echo blocked' },
            { id: 'stop', depends_on: ['check'], kind: 'halt', reason: 'Precondition failed' },
          ],
        },
        workflowRun,
      })
    );

    // cancelWorkflowRun should have been called
    expect(store.cancelWorkflowRun.mock.calls.length).toBe(1);
    expect(store.cancelWorkflowRun).toHaveBeenCalledWith(workflowRun.id, {
      step_name: 'stop',
      reason: 'Precondition failed',
      cancel_reason: 'halt_node',
    });

    // A message with the cancel reason should have been sent
    const sendCalls = platform.sendMessage.mock.calls;
    const cancelMsg = sendCalls.find(
      (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Workflow cancelled')
    );
    expect(cancelMsg).toBeDefined();
  });

  it('cancel node with when: false is skipped', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'cancel-skip-test',
          nodes: [
            { id: 'check', kind: 'exec', runtime: 'sh', script: 'echo ok' },
            {
              id: 'stop',
              depends_on: ['check'],
              kind: 'halt',
              reason: 'Should not fire',
              when: '1 == 0',
            },
          ],
        },
        workflowRun,
      })
    );

    // cancelWorkflowRun should NOT have been called (when: condition is false)
    if (store.cancelWorkflowRun && typeof store.cancelWorkflowRun === 'function') {
      expect(store.cancelWorkflowRun.mock.calls.length).toBe(0);
    }
  });
});
