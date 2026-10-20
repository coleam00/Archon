import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

export function printRunUsage(metadata: WorkflowRun['metadata'] | undefined): void {
  const cost = metadata?.total_cost_usd;
  const input = metadata?.total_tokens_unknown === true ? undefined : metadata?.total_tokens_in;
  const output = metadata?.total_tokens_unknown === true ? undefined : metadata?.total_tokens_out;
  console.log(`  Cost: ${typeof cost === 'number' ? `$${String(cost)}` : 'unknown'}`);
  console.log(`  Input tokens: ${typeof input === 'number' ? String(input) : 'unknown'}`);
  console.log(`  Output tokens: ${typeof output === 'number' ? String(output) : 'unknown'}`);
}
