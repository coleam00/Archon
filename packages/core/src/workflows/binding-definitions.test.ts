import { describe, expect, test } from 'bun:test';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import { refuseWorktreeAfterInPlace } from './binding-definitions';

const workflow = (fields: Partial<ResolvedWorkflow>) =>
  ({ name: 'stage', ...fields }) as ResolvedWorkflow;

describe('a binding start whose base workflow runs in place', () => {
  test("keeps the checkout's copy when it runs in place too", () => {
    const inPlace = workflow({ worktree: { enabled: false } });
    expect(refuseWorktreeAfterInPlace(inPlace)).toBe(inPlace);
  });

  test("refuses when the checkout's copy would get a worktree", () => {
    expect(() => refuseWorktreeAfterInPlace(workflow({}))).toThrow(
      "Workflow 'stage' runs in place"
    );
    expect(() => refuseWorktreeAfterInPlace(workflow({ worktree: { enabled: true } }))).toThrow(
      'start is refused'
    );
  });
});
