import { z } from 'zod';
import { tokenUsageSchema } from '@archon/provider-contract';
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
} as const;

const persistedTokensSchema = tokenUsageSchema.omit({ total: true, cost: true });
const tokenAxes = persistedTokensSchema.keyof().options;
const tokenFields = {
  input: 'total_tokens_in',
  output: 'total_tokens_out',
  cacheRead: 'total_cache_read_tokens',
  cacheWrite: 'total_cache_write_tokens',
  cachePartial: 'total_cache_partial',
} as const satisfies Record<keyof z.infer<typeof persistedTokensSchema>, string>;

export function serializeRunUsage(usage: RunUsageFigures): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (usage.costUsd !== undefined) metadata[fields.cost] = usage.costUsd;
  if (usage.tokensUnknown) {
    metadata[fields.unknown] = true;
    for (const axis of tokenAxes) metadata[tokenFields[axis]] = null;
  } else if (usage.tokens !== undefined) {
    for (const axis of tokenAxes) {
      const value = usage.tokens[axis];
      if (value !== undefined) metadata[tokenFields[axis]] = value;
    }
  }
  return metadata;
}

export function parseRunUsage(metadata: WorkflowRun['metadata']): RunUsageFigures {
  const input = metadata[tokenFields.input];
  const output = metadata[tokenFields.output];
  const cost = metadata[fields.cost];
  const tokensUnknown =
    hasUnknownTokenTotal(metadata) ||
    ((Object.hasOwn(metadata, tokenFields.input) || Object.hasOwn(metadata, tokenFields.output)) &&
      (typeof input !== 'number' ||
        !Number.isFinite(input) ||
        typeof output !== 'number' ||
        !Number.isFinite(output)));
  const parsedTokens = persistedTokensSchema.safeParse(
    Object.fromEntries(
      tokenAxes.flatMap(axis => {
        const parsed = persistedTokensSchema.shape[axis].safeParse(metadata[tokenFields[axis]]);
        return parsed.success && parsed.data !== undefined ? [[axis, parsed.data]] : [];
      })
    )
  );
  const tokens = !tokensUnknown && parsedTokens.success ? parsedTokens.data : undefined;
  return {
    costUsd: typeof cost === 'number' ? cost : undefined,
    ...(tokensUnknown ? { tokensUnknown: true } : { tokens }),
  };
}
