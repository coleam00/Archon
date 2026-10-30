import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { metricOutputSchema } from './metric';

test('the metrics guide publishes the engine record schema', () => {
  const guide = readFileSync(
    join(import.meta.dir, '../../../docs-web/src/content/docs/guides/metrics.md'),
    'utf8'
  );
  const section = guide.split('## The record schema')[1];
  const block = /```json\n([\s\S]*?)\n```/.exec(section ?? '')?.[1];
  expect(block).toBeDefined();
  expect(JSON.parse(block ?? '')).toEqual(z.toJSONSchema(metricOutputSchema));
});
