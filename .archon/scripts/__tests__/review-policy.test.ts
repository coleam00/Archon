import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FULL_REVIEW_RISKS } from '../../workflows/sdlc/.shared/review-policy';
import { runPackScript } from './deliver-checks-harness';

it('delivery exposes the owned policy unchanged', () => {
  const run = runPackScript('deliver/scripts/review-policy');
  expect(run.code).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({ risks: FULL_REVIEW_RISKS });
});

it('the tier consumers read their supplied policy instead of owning a risk list', () => {
  const pack = resolve(import.meta.dir, '../../workflows/sdlc');
  for (const [file, reference] of [
    ['deliver/commands/classify-review-scope.md', '$review-policy.output.risks'],
    ['review/commands/review-focused.md', '$mode.output.risks'],
    ['review/commands/review-synthesize.md', '$mode.output.risks'],
  ]) {
    const command = readFileSync(resolve(pack, file), 'utf8');
    expect(command).toContain(reference);
    expect(command).not.toContain('concurrency over shared state');
  }
});
