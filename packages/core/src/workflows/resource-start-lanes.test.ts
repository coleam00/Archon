import { describe, expect, test } from 'bun:test';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { Codebase } from '../schemas/codebase';
import { handoffIsolation } from './resource-start-lanes';

const HANDOFF = { runId: 'build-run', branch: 'archon/task-build', commit: 'c'.repeat(40) };
const REPO = { kind: 'repo', name: 'acme/widgets' } as Codebase;
const workflow = (fields: Partial<ResolvedWorkflow>) =>
  ({ name: 'stage', ...fields }) as ResolvedWorkflow;

describe('the lane of a start on a handed-off checkout', () => {
  test('a read-only stage is cut at the commit, on a branch of its own', () => {
    expect(handoffIsolation(HANDOFF, workflow({ mutates_checkout: false }), REPO)).toEqual({
      isolation: { kind: 'worktree', fromBranch: HANDOFF.commit },
      lane: 'copy',
    });
  });

  test('a stage that changes its checkout continues on the branch', () => {
    expect(handoffIsolation(HANDOFF, workflow({}), REPO)).toEqual({
      isolation: { kind: 'worktree', branch: HANDOFF.branch },
      lane: 'continue',
    });
  });

  test.each([
    ['a folder project', workflow({}), { ...REPO, kind: 'folder' } as Codebase],
    ['a stage pinned in place', workflow({ worktree: { enabled: false } }), REPO],
  ])('%s is refused', (_label, target, codebase) => {
    expect(() => handoffIsolation(HANDOFF, target, codebase)).toThrow(HANDOFF.runId);
  });
});
