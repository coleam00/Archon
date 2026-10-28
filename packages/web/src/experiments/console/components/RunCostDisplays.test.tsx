import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { toRun, type Run } from '../primitives/run';
import { detailFixture } from '../primitives/run.test-fixtures';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { ActiveRunCard } from './ActiveRunCard';
import { ConsoleWorkflowResultCard } from './ConsoleWorkflowResultCard';
import { RecentRunRow } from './RecentRunRow';
import { RunDetailHeader } from './RunDetailHeader';
import { RunFinishedLine } from './RunLifecycle';

const displays = [
  {
    name: 'detail header',
    render: (run: Run) => <RunDetailHeader run={run} projectName="Archon" projectId={undefined} />,
  },
  {
    name: 'active card',
    render: (run: Run) => <ActiveRunCard run={{ ...run, status: 'running' }} />,
  },
  { name: 'recent row', render: (run: Run) => <RecentRunRow run={run} /> },
  {
    name: 'result card',
    render: (run: Run) => (
      <ConsoleWorkflowResultCard runId={run.id} workflowName={run.workflow} summary="Finished" />
    ),
  },
  { name: 'finished line', render: (run: Run) => <RunFinishedLine run={run} /> },
];

afterEach(() => invalidate(K.run('run-1')));

for (const display of displays) {
  test.each([
    { cost: 0.036, amount: '$0.036' },
    { cost: 0, amount: '$0.0000' },
    { cost: undefined, amount: null },
  ])(`${display.name} discloses cost uncertainty for $cost`, ({ cost, amount }) => {
    const run = toRun({ ...detailFixture.run, metadata: { total_cost_usd: cost } });
    set(K.run(run.id), { run, nodes: [] });
    const html = renderToStaticMarkup(<MemoryRouter>{display.render(run)}</MemoryRouter>);
    if (amount === null) {
      expect(html).not.toContain('Reported cost');
      expect(html).not.toContain('$');
    } else {
      expect(html).toContain(`Reported cost ${amount} (may be partial)`);
    }
    expect(html).not.toContain('Total agent cost');
  });
}
