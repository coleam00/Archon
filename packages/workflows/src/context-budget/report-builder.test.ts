/**
 * T2–T5 — pure report builder tests from synthetic workflow events.
 * No DB, no model, no mocks.
 */
import { describe, test, expect } from 'bun:test';
import { buildContextBudgetReport, type ContextBudgetEventInput } from './report-builder';
import type { ContextBudgetConfig } from '../schemas/context-budget';

function ev(
  event_type: string,
  step_name: string | null,
  data: Record<string, unknown>
): ContextBudgetEventInput {
  return { event_type, step_name, data };
}

describe('buildContextBudgetReport — empty input', () => {
  test('produces an empty report with zeroed totals', () => {
    const report = buildContextBudgetReport('run-1', []);
    expect(report.workflowRunId).toBe('run-1');
    expect(report.nodes).toEqual([]);
    expect(report.totals).toEqual({ estimatedPromptTokens: 0 });
  });

  test('ignores run-level events with null step_name', () => {
    const report = buildContextBudgetReport('run-1', [
      ev('node_completed', null, { tokens: { input: 10, output: 5 } }),
    ]);
    expect(report.nodes).toEqual([]);
  });
});

describe('T2 — per-node + total numbers and classification', () => {
  const events: ContextBudgetEventInput[] = [
    ev('context_budget_computed', 'implement', {
      estimatedPromptTokens: 1200,
      budgetTokens: 50000,
    }),
    ev('tool_called', 'implement', {
      tool_name: 'Read',
      tool_input: { file_path: 'src/auth/login.ts' },
    }),
    ev('tool_called', 'implement', { tool_name: 'Grep', tool_input: { pattern: 'TODO' } }),
    ev('node_completed', 'implement', {
      tokens: { input: 3000, output: 500, total: 3500, cost: 0.02 },
    }),
    ev('context_budget_computed', 'review', { estimatedPromptTokens: 800 }),
    ev('node_completed', 'review', { tokens: { input: 1000, output: 200 } }),
  ];

  const report = buildContextBudgetReport('run-2', events);

  test('preserves first-seen node order', () => {
    expect(report.nodes.map(n => n.nodeId)).toEqual(['implement', 'review']);
  });

  test('implement node: exact L1/L2 numbers + budget', () => {
    const node = report.nodes[0];
    expect(node.estimatedPromptTokens).toBe(1200);
    expect(node.budgetTokens).toBe(50000);
    expect(node.actualTokens).toEqual({ input: 3000, output: 500, total: 3500, cost: 0.02 });
  });

  test('implement node: L3 reads classified correctly', () => {
    const node = report.nodes[0];
    expect(node.reads).toHaveLength(2);
    expect(node.reads[0]).toEqual({
      nodeId: 'implement',
      layer: 'dynamic-read',
      sourceType: 'file-read',
      label: 'login.ts',
      detail: 'src/auth/login.ts',
    });
    expect(node.reads[1]).toEqual({
      nodeId: 'implement',
      layer: 'dynamic-read',
      sourceType: 'grep',
      label: 'TODO',
      detail: 'TODO',
    });
  });

  test('implement node: no_test_context warning (read a non-test file)', () => {
    const codes = report.nodes[0].warnings.map(w => w.code);
    expect(codes).toEqual(['no_test_context']);
  });

  test('review node: actual without total/cost, no reads, no warnings', () => {
    const node = report.nodes[1];
    expect(node.estimatedPromptTokens).toBe(800);
    expect(node.budgetTokens).toBeUndefined();
    expect(node.actualTokens).toEqual({ input: 1000, output: 200 });
    expect(node.reads).toEqual([]);
    expect(node.warnings).toEqual([]);
  });

  test('totals roll up across nodes', () => {
    expect(report.totals.estimatedPromptTokens).toBe(2000);
    expect(report.totals.actualTokens).toBe(4700); // 3500 + (1000+200)
    expect(report.totals.costUsd).toBe(0.02);
  });
});

describe('T3 — dynamic-read reconstruction from tool_input.file_path', () => {
  test('a Read surfaces as an L3 file-read item', () => {
    const report = buildContextBudgetReport('run-3', [
      ev('tool_called', 'n1', {
        tool_name: 'Read',
        tool_input: { file_path: 'src/auth/login.ts' },
      }),
    ]);
    const reads = report.nodes[0].reads;
    expect(reads).toHaveLength(1);
    expect(reads[0].layer).toBe('dynamic-read');
    expect(reads[0].sourceType).toBe('file-read');
    expect(reads[0].label).toBe('login.ts');
    expect(reads[0].detail).toBe('src/auth/login.ts');
  });

  test('unknown (non-read) tools are skipped', () => {
    const report = buildContextBudgetReport('run-3b', [
      ev('tool_called', 'n1', { tool_name: 'WebFetch', tool_input: { url: 'https://x.dev' } }),
    ]);
    expect(report.nodes[0].reads).toEqual([]);
  });

  test('a Read missing file_path falls back to the tool name label', () => {
    const report = buildContextBudgetReport('run-3c', [
      ev('tool_called', 'n1', { tool_name: 'Read', tool_input: {} }),
    ]);
    const read = report.nodes[0].reads[0];
    expect(read.sourceType).toBe('file-read');
    expect(read.label).toBe('Read');
    expect(read.detail).toBeUndefined();
  });
});

describe('T4 — over_budget threshold', () => {
  const config: ContextBudgetConfig = { maxTokens: 10000, warnAtPercent: 80 };

  test('measured 8500 ≥ 80% of 10000 → one over_budget warning', () => {
    const report = buildContextBudgetReport(
      'run-4',
      [ev('node_completed', 'n1', { tokens: { input: 8000, output: 500, total: 8500 } })],
      config
    );
    const overBudget = report.nodes[0].warnings.filter(w => w.code === 'over_budget');
    expect(overBudget).toHaveLength(1);
  });

  test('measured 5000 < 80% of 10000 → no over_budget warning', () => {
    const report = buildContextBudgetReport(
      'run-4b',
      [ev('node_completed', 'n1', { tokens: { input: 4500, output: 500, total: 5000 } })],
      config
    );
    const overBudget = report.nodes[0].warnings.filter(w => w.code === 'over_budget');
    expect(overBudget).toHaveLength(0);
  });

  test('no budget configured → no over_budget warning', () => {
    const report = buildContextBudgetReport('run-4c', [
      ev('node_completed', 'n1', { tokens: { input: 9000, output: 5000, total: 14000 } }),
    ]);
    const overBudget = report.nodes[0].warnings.filter(w => w.code === 'over_budget');
    expect(overBudget).toHaveLength(0);
  });

  test('per-node budget from event overrides config for the threshold', () => {
    const report = buildContextBudgetReport(
      'run-4d',
      [
        ev('context_budget_computed', 'n1', { estimatedPromptTokens: 100, budgetTokens: 1000 }),
        ev('node_completed', 'n1', { tokens: { input: 800, output: 100, total: 900 } }),
      ],
      { warnAtPercent: 80 } // no maxTokens at config level; budget comes from the event
    );
    const overBudget = report.nodes[0].warnings.filter(w => w.code === 'over_budget');
    expect(overBudget).toHaveLength(1); // 900 ≥ 80% of 1000
  });
});

describe('T5 — low_value_read detection', () => {
  const lockRead: ContextBudgetEventInput = ev('tool_called', 'n1', {
    tool_name: 'Read',
    tool_input: { file_path: 'package-lock.json' },
  });

  test('warnOnLowValueReads: true → low_value_read warning', () => {
    const report = buildContextBudgetReport('run-5', [lockRead], { warnOnLowValueReads: true });
    const lowValue = report.nodes[0].warnings.filter(w => w.code === 'low_value_read');
    expect(lowValue).toHaveLength(1);
    expect(lowValue[0].message).toContain('package-lock.json');
  });

  test('warnOnLowValueReads off → no low_value_read warning', () => {
    const report = buildContextBudgetReport('run-5b', [lockRead], { warnOnLowValueReads: false });
    const lowValue = report.nodes[0].warnings.filter(w => w.code === 'low_value_read');
    expect(lowValue).toHaveLength(0);
  });

  test('no config → no low_value_read warning', () => {
    const report = buildContextBudgetReport('run-5c', [lockRead]);
    const lowValue = report.nodes[0].warnings.filter(w => w.code === 'low_value_read');
    expect(lowValue).toHaveLength(0);
  });

  test('deduplicates repeated low-value reads of the same path', () => {
    const report = buildContextBudgetReport('run-5d', [lockRead, lockRead], {
      warnOnLowValueReads: true,
    });
    const lowValue = report.nodes[0].warnings.filter(w => w.code === 'low_value_read');
    expect(lowValue).toHaveLength(1);
  });

  test('does not fire on a bash command whose text coincidentally matches a lockfile', () => {
    const report = buildContextBudgetReport(
      'run-5e',
      [
        ev('tool_called', 'n1', {
          tool_name: 'Bash',
          tool_input: { command: 'cat package-lock.json' },
        }),
      ],
      { warnOnLowValueReads: true }
    );
    const lowValue = report.nodes[0].warnings.filter(w => w.code === 'low_value_read');
    expect(lowValue).toHaveLength(0);
  });

  test('does not fire on a grep pattern that resembles a lockfile name', () => {
    const report = buildContextBudgetReport(
      'run-5f',
      [
        ev('tool_called', 'n1', {
          tool_name: 'Grep',
          tool_input: { pattern: 'package-lock.json' },
        }),
      ],
      { warnOnLowValueReads: true }
    );
    const lowValue = report.nodes[0].warnings.filter(w => w.code === 'low_value_read');
    expect(lowValue).toHaveLength(0);
  });
});
