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
