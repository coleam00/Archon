import { describe, test, expect } from 'bun:test';
import { isRunInSubscriptionScope, type GetRunAncestry } from './run-subscription-membership';
import type { WorkflowRun } from './schemas';

const mockRun = (id: string): WorkflowRun => ({ id }) as WorkflowRun;

describe('isRunInSubscriptionScope', () => {
  test('same run is in scope', async () => {
    const getRunAncestry: GetRunAncestry = async () => {
      throw new Error('must not be called for the same-run case');
    };

    await expect(isRunInSubscriptionScope('run-a', 'run-a', getRunAncestry)).resolves.toBe(true);
  });

  test('direct child is in scope', async () => {
    const getRunAncestry: GetRunAncestry = async runId => {
      expect(runId).toBe('child');
      return [mockRun('parent')];
    };

    await expect(isRunInSubscriptionScope('child', 'parent', getRunAncestry)).resolves.toBe(true);
  });

  test('grandchild is in scope (nested sub-run)', async () => {
    const getRunAncestry: GetRunAncestry = async runId => {
      expect(runId).toBe('grandchild');
      return [mockRun('parent'), mockRun('grandparent')];
    };

    await expect(
      isRunInSubscriptionScope('grandchild', 'grandparent', getRunAncestry)
    ).resolves.toBe(true);
  });

  test('unrelated run is out of scope', async () => {
    const getRunAncestry: GetRunAncestry = async () => [mockRun('some-other-parent')];

    await expect(isRunInSubscriptionScope('run-b', 'run-a', getRunAncestry)).resolves.toBe(false);
  });
});
