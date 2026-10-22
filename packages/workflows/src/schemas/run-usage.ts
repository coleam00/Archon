import { z } from 'zod';
import { tokenUsageSchema, type TokenUsage } from '@archon/provider-contract';
import type { WorkflowRun } from './workflow-run';

export const runUsageSchema = z.object({
  costUsd: z.number().optional(),
  tokens: tokenUsageSchema.optional(),
  tokensUnknown: z.boolean().optional(),
});
export type RunUsageFigures = z.infer<typeof runUsageSchema>;

export function hasUnknownTokenTotal(metadata: WorkflowRun['metadata']): boolean {
  return Object.hasOwn(metadata, fields.unknown) && metadata[fields.unknown] !== false;
}

const fields = {
  cost: 'total_cost_usd',
  unknown: 'total_tokens_unknown',
  input: 'total_tokens_in',
  output: 'total_tokens_out',
  cacheRead: 'total_cache_read_tokens',
  cacheWrite: 'total_cache_write_tokens',
  cachePartial: 'total_cache_partial',
} as const;

const tokenAxes = ['input', 'output', 'cacheRead', 'cacheWrite', 'cachePartial'] as const;

export function serializeRunUsage(usage: RunUsageFigures): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (usage.costUsd !== undefined) metadata[fields.cost] = usage.costUsd;
  if (usage.tokensUnknown) {
    metadata[fields.unknown] = true;
    for (const axis of tokenAxes) metadata[fields[axis]] = null;
  } else if (usage.tokens !== undefined) {
    for (const axis of tokenAxes) {
      const value = usage.tokens[axis];
      if (value !== undefined) metadata[fields[axis]] = value;
    }
  }
  return metadata;
}

export function parseRunUsage(metadata: WorkflowRun['metadata']): RunUsageFigures {
  const input = metadata[fields.input];
  const output = metadata[fields.output];
  const cost = metadata[fields.cost];
  const tokensUnknown =
    hasUnknownTokenTotal(metadata) ||
    ((Object.hasOwn(metadata, fields.input) || Object.hasOwn(metadata, fields.output)) &&
      (typeof input !== 'number' ||
        !Number.isFinite(input) ||
        typeof output !== 'number' ||
        !Number.isFinite(output)));
  let tokens: TokenUsage | undefined;
  if (!tokensUnknown && typeof input === 'number' && typeof output === 'number') {
    tokens = { input, output };
    for (const axis of ['cacheRead', 'cacheWrite'] as const) {
      const value = metadata[fields[axis]];
      if (typeof value === 'number') tokens[axis] = value;
    }
    if (metadata[fields.cachePartial] === true) tokens.cachePartial = true;
  }
  return {
    costUsd: typeof cost === 'number' ? cost : undefined,
    ...(tokensUnknown ? { tokensUnknown: true } : { tokens }),
  };
}
