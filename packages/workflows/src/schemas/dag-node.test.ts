import { describe, test, expect } from 'bun:test';
import { dagNodeSchema, BASH_NODE_AI_FIELDS } from './dag-node';

// ---------------------------------------------------------------------------
// agent: field schema tests
// ---------------------------------------------------------------------------

describe('dagNodeSchema agent field', () => {
  test('accepts prompt node with agent: field', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      agent: 'war-council-architect',
      prompt: 'Plan the implementation.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBe('war-council-architect');
    }
  });

  test('accepts command node with agent: field', () => {
    const result = dagNodeSchema.safeParse({
      id: 'review',
      agent: 'codex-adversarial-reviewer',
      command: 'archon-assist',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBe('codex-adversarial-reviewer');
    }
  });

  test('agent field is optional — node without agent still validates', () => {
    const result = dagNodeSchema.safeParse({
      id: 'step',
      prompt: 'Do the thing.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBeUndefined();
    }
  });

  test('node with agent AND model both present — schema accepts it (executor logs warning)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'implement',
      agent: 'major-build',
      model: 'sonnet',
      prompt: 'Implement the plan.',
    });
    // Schema allows coexistence — executor handles model precedence at runtime
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBe('major-build');
      expect((result.data as { model?: string }).model).toBe('sonnet');
    }
  });

  test('rejects empty string for agent', () => {
    const result = dagNodeSchema.safeParse({
      id: 'step',
      agent: '',
      prompt: 'Do it.',
    });
    expect(result.success).toBe(false);
  });

  test('backward compat: node without agent uses node model as before', () => {
    const result = dagNodeSchema.safeParse({
      id: 'step',
      model: 'opus',
      prompt: 'Do it.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { model?: string }).model).toBe('opus');
      expect((result.data as { agent?: string }).agent).toBeUndefined();
    }
  });

  test('agent is listed in BASH_NODE_AI_FIELDS (bash nodes should not use it)', () => {
    expect(BASH_NODE_AI_FIELDS).toContain('agent');
  });

  test('bash node with agent field is accepted by schema (warning only, not error)', () => {
    // The schema itself does not error on bash+agent — loader emits a warning at parse time
    const result = dagNodeSchema.safeParse({
      id: 'step',
      bash: 'echo hello',
      agent: 'war-council-architect',
    });
    // Bash nodes accept agent in the raw schema since all base fields pass through
    expect(result.success).toBe(true);
  });
});
