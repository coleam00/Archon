import { expect, test } from 'bun:test';
import { workflowRunSchema } from './workflow-run';
import { workflowRunUsageSchema } from './workflow-run-usage';

test('persisted usage stays optional and preserves zero, unknown, and unrelated metadata', () => {
  const metadata = workflowRunSchema.shape.metadata;
  expect(metadata.parse({ summary: 'done' })).toEqual({ summary: 'done' });
  const zero = { total_cost_usd: 0, total_tokens_in: 0, total_tokens_out: 0 };
  expect(metadata.parse(zero)).toEqual(zero);
  const unknown = {
    total_tokens_unknown: true,
    total_tokens_in: null,
    total_tokens_out: null,
    total_cache_read_tokens: null,
    total_cache_write_tokens: null,
    total_cache_partial: null,
  };
  expect(metadata.parse(unknown)).toEqual(unknown);
  const legacy = { total_cost_usd: 'free', total_tokens_in: 'unknown' };
  expect(metadata.parse(legacy)).toEqual(legacy);
  expect(workflowRunUsageSchema.safeParse({ total_cost_usd: 'free' }).success).toBe(false);
});
