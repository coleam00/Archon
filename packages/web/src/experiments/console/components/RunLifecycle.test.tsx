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

test('a run that failed at launch shows the reason; a failed node leaves it to the node row', () => {
  const failed = (first_failed_node: string | null) =>
    toRun({
      ...detailFixture.run,
      status: 'failed',
      outcome: null,
      terminal_record: {
        ...detailFixture.run.terminal_record!,
        status: 'failed',
        error: 'Cannot determine git remote',
        first_failed_node,
      },
    });
  expect(renderToStaticMarkup(<RunFinishedLine run={failed(null)} />)).toContain(
    'Cannot determine git remote'
  );
  expect(renderToStaticMarkup(<RunFinishedLine run={failed('boom')} />)).not.toContain(
    'Cannot determine git remote'
  );
});
