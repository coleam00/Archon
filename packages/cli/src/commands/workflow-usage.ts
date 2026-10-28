import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { hasUnknownTokenTotal } from '@archon/workflows/schemas/run-usage';

function recordedCost(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `$${value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 12 })}`
    : 'unknown';
}

function recordedTokens(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? String(value)
    : 'unknown';
}

export function formatRunUsage(metadata: WorkflowRun['metadata']): string[] {
  const tokensUnknown = hasUnknownTokenTotal(metadata);
  return [
    '  Usage (recorded totals; completeness unknown):',
    `    Cost: ${recordedCost(metadata.total_cost_usd)}`,
    `    Input tokens: ${tokensUnknown ? 'unknown' : recordedTokens(metadata.total_tokens_in)}`,
    `    Output tokens: ${tokensUnknown ? 'unknown' : recordedTokens(metadata.total_tokens_out)}`,
  ];
}
