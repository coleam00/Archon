/**
 * T6 — Markdown render snapshot for a fixed report.
 * Pure, no mocks. Locks the artifact format against regression.
 */
import { describe, test, expect } from 'bun:test';
import { renderReportMarkdown } from './report-markdown';
import type { ContextBudgetReport } from '../schemas/context-budget';

const FIXED_REPORT: ContextBudgetReport = {
  workflowRunId: 'run-snap',
  nodes: [
    {
      nodeId: 'implement',
      budgetTokens: 50000,
      estimatedPromptTokens: 1200,
      actualTokens: { input: 3000, output: 500, total: 3500, cost: 0.02 },
      reads: [
        {
          nodeId: 'implement',
          layer: 'dynamic-read',
          sourceType: 'file-read',
          label: 'login.ts',
          detail: 'src/auth/login.ts',
        },
        {
          nodeId: 'implement',
          layer: 'dynamic-read',
          sourceType: 'grep',
          label: 'TODO',
          detail: 'TODO',
        },
      ],
      warnings: [
        {
          nodeId: 'implement',
          code: 'no_test_context',
          message:
            "node 'implement' read 1 file(s) but no test files — expected context may be missing",
        },
      ],
    },
    {
      nodeId: 'review',
      estimatedPromptTokens: 800,
      reads: [],
      warnings: [],
    },
  ],
  totals: { estimatedPromptTokens: 2000, actualTokens: 3500, costUsd: 0.02 },
};

const EXPECTED = [
  '# Context Budget Report',
  '',
  'Run: `run-snap`',
  '',
  '## Summary',
  '',
  '| Total | Value |',
  '| --- | --- |',
  '| Estimated prompt tokens (L1) | 2,000 |',
  '| Actual tokens (L2) | 3,500 |',
  '| Cost (L2) | $0.0200 |',
  '',
  '## Nodes',
  '',
  '### Node: `implement`',
  '',
  '| Measure | Tokens |',
  '| --- | --- |',
  '| Estimated prompt (L1) | 1,200 |',
  '| Actual input (L2) | 3,000 |',
  '| Actual output (L2) | 500 |',
  '| Actual total (L2) | 3,500 |',
  '| Actual cost (L2) | $0.0200 |',
  '| Budget (advisory) | 50,000 |',
  '',
  '**Files read (L3):**',
  '',
  '| Source | Detail |',
  '| --- | --- |',
  '| file-read | src/auth/login.ts |',
  '| grep | TODO |',
  '',
  '**Warnings:**',
  '',
  "- **No test context** — node 'implement' read 1 file(s) but no test files — expected context may be missing",
  '',
  '### Node: `review`',
  '',
  '| Measure | Tokens |',
  '| --- | --- |',
  '| Estimated prompt (L1) | 800 |',
  '| Actual (L2) | _not recorded_ |',
  '',
  '## Recommendations',
  '',
  "- node 'implement' read 1 file(s) but no test files — expected context may be missing",
  '',
].join('\n');

describe('renderReportMarkdown', () => {
  test('T6: stable Markdown snapshot for a fixed report', () => {
    expect(renderReportMarkdown(FIXED_REPORT)).toBe(EXPECTED);
  });

  test('is deterministic across calls', () => {
    expect(renderReportMarkdown(FIXED_REPORT)).toBe(renderReportMarkdown(FIXED_REPORT));
  });

  test('escapes pipes in read detail so the L3 table stays well-formed', () => {
    const md = renderReportMarkdown({
      workflowRunId: 'run-pipe',
      nodes: [
        {
          nodeId: 'n1',
          estimatedPromptTokens: 10,
          reads: [
            {
              nodeId: 'n1',
              layer: 'dynamic-read',
              sourceType: 'grep',
              label: 'foo|bar',
              detail: 'foo|bar',
            },
          ],
          warnings: [],
        },
      ],
      totals: { estimatedPromptTokens: 10 },
    });
    expect(md).toContain('| grep | foo\\|bar |');
    expect(md).not.toContain('| grep | foo|bar |');
  });

  test('renders an empty report without throwing', () => {
    const md = renderReportMarkdown({
      workflowRunId: 'empty',
      nodes: [],
      totals: { estimatedPromptTokens: 0 },
    });
    expect(md).toContain('_No measured nodes._');
    expect(md).toContain('_No advisory warnings._');
  });
});
