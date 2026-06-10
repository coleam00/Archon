/**
 * Tests for the workflow-side OMP preflight collector + liveness gating.
 *
 * Runs in its own `bun test` invocation (see package.json) because it
 * mock.module()s `@archon/providers/community/omp/model-preflight`, which
 * model-preflight.ts lazy-imports.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface RecordedCall {
  modelPaths: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  options?: { live?: boolean };
}

const recordedCalls: RecordedCall[] = [];
let nextResults: { modelPath: string; ok: boolean; error?: string }[] = [];

mock.module('@archon/providers/community/omp/model-preflight', () => ({
  checkModelResolutionAll: mock(
    async (
      modelPaths: readonly string[],
      cwd: string,
      env?: Record<string, string>,
      options?: { live?: boolean }
    ) => {
      recordedCalls.push({ modelPaths, cwd, env, options });
      return nextResults.length > 0
        ? nextResults
        : modelPaths.map(p => ({ modelPath: p, ok: true }));
    }
  ),
}));

import { collectOmpModelPaths, validateOmpModelLiveness } from './model-preflight';
import type { WorkflowDefinition, DagNode } from './schemas';

function makeWorkflow(
  nodes: DagNode[],
  overrides?: Partial<WorkflowDefinition>
): WorkflowDefinition {
  return {
    name: 'preflight-test',
    description: 'test',
    nodes,
    ...overrides,
  } as WorkflowDefinition;
}

beforeEach(() => {
  recordedCalls.length = 0;
  nextResults = [];
});

describe('collectOmpModelPaths', () => {
  test('collects node model and on_failure_model for omp nodes', () => {
    const workflow = makeWorkflow(
      [
        {
          id: 'a',
          prompt: 'p',
          provider: 'omp',
          model: 'minimax-token-plan/MiniMax-M3',
          on_failure_model: 'anthropic/claude-haiku-4-5',
        } as DagNode,
      ],
      { provider: 'claude' }
    );
    const paths = collectOmpModelPaths(workflow);
    expect(paths).toContain('minimax-token-plan/MiniMax-M3');
    expect(paths).toContain('anthropic/claude-haiku-4-5');
  });

  test('returns empty for non-omp workflows', () => {
    const workflow = makeWorkflow([{ id: 'a', prompt: 'p', model: 'opus' } as DagNode], {
      provider: 'claude',
    });
    expect(collectOmpModelPaths(workflow)).toEqual([]);
  });

  test('uses workflow-level model when omp node has no model', () => {
    const workflow = makeWorkflow([{ id: 'a', prompt: 'p' } as DagNode], {
      provider: 'omp',
      model: 'cursor/composer-2.5',
    });
    expect(collectOmpModelPaths(workflow)).toEqual(['cursor/composer-2.5']);
  });
});

describe('validateOmpModelLiveness', () => {
  const ompWorkflow = makeWorkflow(
    [{ id: 'a', prompt: 'p', provider: 'omp', model: 'cursor/composer-2.5' } as DagNode],
    {}
  );

  test('skips the provider check entirely when no omp models are referenced', async () => {
    const workflow = makeWorkflow([{ id: 'a', prompt: 'p' } as DagNode], { provider: 'claude' });
    const issues = await validateOmpModelLiveness(workflow, '/tmp');
    expect(issues).toEqual([]);
    expect(recordedCalls).toHaveLength(0);
  });

  test('defaults to the cheap check (live: false)', async () => {
    const issues = await validateOmpModelLiveness(ompWorkflow, '/tmp');
    expect(issues).toEqual([]);
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].options).toEqual({ live: false });
  });

  test('passes live: true through when requested', async () => {
    await validateOmpModelLiveness(ompWorkflow, '/tmp', undefined, undefined, { live: true });
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].options).toEqual({ live: true });
  });

  test('maps failed checks to error issues', async () => {
    nextResults = [{ modelPath: 'cursor/composer-2.5', ok: false, error: 'no credentials' }];
    const issues = await validateOmpModelLiveness(ompWorkflow, '/tmp');
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].message).toContain('cursor/composer-2.5');
    expect(issues[0].message).toContain('no credentials');
  });
});
