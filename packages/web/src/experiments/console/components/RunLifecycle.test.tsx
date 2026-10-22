import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { detailFixture } from '../primitives/run.test-fixtures';
import { toRun } from '../primitives/run';
import { RunFinishedLine } from './RunLifecycle';

test('a completed execution with a failed authored outcome shows its explanation', () => {
  const html = renderToStaticMarkup(<RunFinishedLine run={toRun(detailFixture.run)} />);
  expect(html).toContain('Completed');
  expect(html).toContain('Outcome: failed');
  expect(html).toContain('An open PR already implements this fix.');
});

test.each([undefined, true] as const)('finished lines qualify cost completeness %s', marker => {
  const run = toRun({
    ...detailFixture.run,
    metadata: { total_cost_usd: 0.2, ...(marker ? { total_cost_incomplete: true } : {}) },
  });
  const html = renderToStaticMarkup(<RunFinishedLine run={run} />);
  expect(html).toContain(marker ? '≥$0.200 (incomplete)' : '$0.200 (completeness unknown)');
});
