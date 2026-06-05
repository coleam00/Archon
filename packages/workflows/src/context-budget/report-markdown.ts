/**
 * Markdown renderer for the Context Budget Visualizer report (observability).
 *
 * `renderReportMarkdown` turns a `ContextBudgetReport` into a human-readable
 * Markdown document for the run artifacts dir (`context-budget-report.md`).
 * Deterministic output (stable ordering, fixed number formatting) so snapshots
 * lock against regression. Pure — no I/O. Phase 1 only defines it; the executor
 * writes the artifact in Phase 2.
 */
import type {
  ContextBudgetNodeReport,
  ContextBudgetReport,
  ContextBudgetWarning,
} from '../schemas/context-budget';

/** Format an integer with thousands separators (deterministic, locale-free). */
function fmt(n: number): string {
  const rounded = Math.round(n);
  const negative = rounded < 0;
  const digits = Math.abs(rounded).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/** Format a USD cost to 4 decimal places. */
function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * Escape a free-form string for a Markdown table cell. Pipes (common in grep
 * alternations and bash commands) would add spurious columns; newlines would
 * split the row. Both are neutralised so the table stays well-formed.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const WARNING_LABELS: Record<ContextBudgetWarning['code'], string> = {
  over_budget: 'Over budget',
  low_value_read: 'Low-value read',
  no_test_context: 'No test context',
};

function renderNode(node: ContextBudgetNodeReport): string {
  const lines: string[] = [];
  lines.push(`### Node: \`${node.nodeId}\``);
  lines.push('');

  // Token table — estimated (L1) vs actual (L2), clearly distinguished.
  lines.push('| Measure | Tokens |');
  lines.push('| --- | --- |');
  lines.push(`| Estimated prompt (L1) | ${fmt(node.estimatedPromptTokens)} |`);
  if (node.actualTokens) {
    const a = node.actualTokens;
    const total = a.total ?? a.input + a.output;
    lines.push(`| Actual input (L2) | ${fmt(a.input)} |`);
    lines.push(`| Actual output (L2) | ${fmt(a.output)} |`);
    lines.push(`| Actual total (L2) | ${fmt(total)} |`);
    if (a.cost !== undefined) lines.push(`| Actual cost (L2) | ${fmtCost(a.cost)} |`);
  } else {
    lines.push('| Actual (L2) | _not recorded_ |');
  }
  if (node.budgetTokens !== undefined) {
    lines.push(`| Budget (advisory) | ${fmt(node.budgetTokens)} |`);
  }
  lines.push('');

  // Dynamic reads (L3).
  if (node.reads.length > 0) {
    lines.push('**Files read (L3):**');
    lines.push('');
    lines.push('| Source | Detail |');
    lines.push('| --- | --- |');
    for (const read of node.reads) {
      lines.push(`| ${read.sourceType} | ${escapeCell(read.detail ?? read.label)} |`);
    }
    lines.push('');
  }

  // Warnings.
  if (node.warnings.length > 0) {
    lines.push('**Warnings:**');
    lines.push('');
    for (const w of node.warnings) {
      lines.push(`- **${WARNING_LABELS[w.code]}** — ${w.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render a `ContextBudgetReport` as Markdown. Deterministic — node order follows
 * the report's `nodes` array, numbers are formatted consistently.
 */
export function renderReportMarkdown(report: ContextBudgetReport): string {
  const lines: string[] = [];

  lines.push('# Context Budget Report');
  lines.push('');
  lines.push(`Run: \`${report.workflowRunId}\``);
  lines.push('');

  // Summary.
  lines.push('## Summary');
  lines.push('');
  lines.push('| Total | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Estimated prompt tokens (L1) | ${fmt(report.totals.estimatedPromptTokens)} |`);
  lines.push(
    `| Actual tokens (L2) | ${
      report.totals.actualTokens !== undefined ? fmt(report.totals.actualTokens) : '_not recorded_'
    } |`
  );
  lines.push(
    `| Cost (L2) | ${
      report.totals.costUsd !== undefined ? fmtCost(report.totals.costUsd) : '_not recorded_'
    } |`
  );
  lines.push('');

  const allWarnings = report.nodes.flatMap(n => n.warnings);

  // Per-node detail.
  lines.push('## Nodes');
  lines.push('');
  if (report.nodes.length === 0) {
    lines.push('_No measured nodes._');
    lines.push('');
  } else {
    for (const node of report.nodes) {
      lines.push(renderNode(node));
    }
  }

  // Recommendations derived from warnings.
  lines.push('## Recommendations');
  lines.push('');
  if (allWarnings.length === 0) {
    lines.push('_No advisory warnings._');
  } else {
    for (const w of allWarnings) {
      lines.push(`- ${w.message}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
