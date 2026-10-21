import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

function recordedNumber(value: unknown, prefix = ''): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${prefix}${String(value)}`
    : 'unknown';
}

export function formatRunUsage(metadata: WorkflowRun['metadata']): string[] {
  const tokensUnknown =
    Object.hasOwn(metadata, 'total_tokens_unknown') && metadata.total_tokens_unknown !== false;
  return [
    '  Usage (recorded totals; completeness unknown):',
    `    Cost: ${recordedNumber(metadata.total_cost_usd, '$')}`,
    `    Input tokens: ${tokensUnknown ? 'unknown' : recordedNumber(metadata.total_tokens_in)}`,
    `    Output tokens: ${tokensUnknown ? 'unknown' : recordedNumber(metadata.total_tokens_out)}`,
  ];
}
