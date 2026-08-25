import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition } from '@/lib/api';
import { overlayBuilderEdits } from './WorkflowBuilder';

describe('overlayBuilderEdits', () => {
  test('preserves fetched top-level fields while replacing builder-owned fields', () => {
    const loaded: WorkflowDefinition = {
      name: 'governed',
      description: 'Before edit',
      provider: 'claude',
      model: 'large',
      budget: { max_spend_usd: 5, max_work_units: 10 },
      evidence_policy: { required: true },
      mutates_checkout: false,
      nodes: [{ id: 'before', prompt: 'Before' }],
    };

    const saved = overlayBuilderEdits(loaded, {
      name: 'governed',
      description: 'After edit',
      provider: 'codex',
      model: undefined,
      nodes: [{ id: 'after', prompt: 'After' }],
    });

    expect(saved).toEqual({
      ...loaded,
      description: 'After edit',
      provider: 'codex',
      model: undefined,
      nodes: [{ id: 'after', prompt: 'After' }],
    });
  });
});
