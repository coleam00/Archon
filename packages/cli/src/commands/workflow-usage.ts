import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { parseRunUsage } from '@archon/workflows/schemas/run-usage';

function recordedCost(value: number | undefined): string {
  return value !== undefined
    ? `$${value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 12 })}`
    : 'unknown';
}

function recordedTokens(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? String(value)
    : 'unknown';
}

export function formatRunUsage(metadata: WorkflowRun['metadata']): string[] {
  const usage = parseRunUsage(metadata, { partialTokens: true });
  return [
    '  Usage (recorded totals; completeness unknown):',
    `    Cost: ${recordedCost(usage.costUsd)}`,
    `    Input tokens: ${recordedTokens(usage.tokens?.input)}`,
    `    Output tokens: ${recordedTokens(usage.tokens?.output)}`,
  ];
}
