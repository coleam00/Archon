import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { Run } from '../primitives/run';
import { ActiveRunCard } from './ActiveRunCard';

const parallelRun: Run = {
  id: 'run-parallel',
  projectId: null,
  projectName: 'Archon',
  costUsd: null,
  conversationId: null,
  conversationPlatformId: null,
  workerPlatformId: null,
  workflow: 'implement',
  origin: 'cli',
  status: 'running',
  attention: null,
  outcome: null,
  terminalRecord: null,
  startedAt: '2026-09-01T10:00:00.000Z',
  finishedAt: null,
  workingPath: null,
  userMessage: 'Implement the change',
  activeNodes: ['parallel-a', 'parallel-b'],
};

type Progress = NonNullable<Run['progress']>;

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function progressOf(overrides: Partial<Progress> = {}): Progress {
  return {
    steps: [
      { node_id: 'plan', state: 'completed', kind: 'agent', duration_ms: 83_000 },
      { node_id: 'parallel-a', state: 'running', kind: 'agent', model: 'opus-test' },
      { node_id: 'report', state: 'pending' },
    ],
    last_observed_at: minutesAgo(4),
    last_message: {
      node_id: 'plan',
      at: minutesAgo(4),
      text: ['Reading the failing test.', 'Then the parser.'].join('\n'),
    },
    branch: 'archon/task-42',
    base_branch: 'dev',
    ...overrides,
  };
}

const itemRun: Run = {
  ...parallelRun,
  id: '0f3a9c1e-run',
  itemKey: 'issue-42',
  workingPath: '/work/trees/task-42',
  costUsd: 1.5,
  progress: progressOf(),
};

function render(run: Run, expanded = false): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ActiveRunCard run={run} expanded={expanded} />
    </MemoryRouter>
  );
}

describe('ActiveRunCard', () => {
  test('renders every active node for a parallel run', () => {
    const html = render(parallelRun);

    expect(html).toContain('nodes');
    expect(html).toContain('parallel-a, parallel-b');
  });

  test('a compact card shows the item, workflow, phase, strip and times, and no details', () => {
    const html = render(itemRun);

    expect(html).toContain('issue-42');
    expect(html).toContain('implement');
    expect(html).toContain('parallel-a, parallel-b');
    expect(html).toContain('Reading the failing test.');
    expect(html).not.toContain('Then the parser.');
    expect(html).toContain('aria-label="1 of 3 steps done"');
    expect(html.match(/title="[^"]+ · (completed|running|pending)"/g)).toHaveLength(3);
    expect(html).toContain('active 4m ago');

    for (const detail of [
      'Cancel',
      'Log',
      'opus-test',
      'archon/task-42',
      'Reported cost',
      '/work/trees/task-42',
      'title="0f3a9c1e-run"',
      'last message',
      '01:23',
    ]) {
      expect(html).not.toContain(detail);
    }
  });

  test('an expanded card adds step times, the last message, facts, actions and internals', () => {
    const html = render(
      { ...itemRun, parentRunId: 'parent-run-id', adoptedFromRunId: 'earlier-run-id' },
      true
    );

    expect(html).toContain('01:23');
    expect(html).toContain('Then the parser.');
    expect(html).toContain('last message · plan');
    expect(html).toContain('archon/task-42');
    expect(html).toContain('opus-test');
    expect(html).toContain('Reported cost $1.50 (may be partial)');
    expect(html).toContain('Origin: CLI');
    expect(html).toContain('Cancel');
    expect(html).toContain('href="/console/r/0f3a9c1e-run"');
    expect(html).toContain('title="0f3a9c1e-run"');
    expect(html).toContain('/work/trees/task-42');
    expect(html).toContain('Base branch');
    expect(html).toContain('child of parentru');
    expect(html).toContain('continues earlierr');
    expect(html).toContain('Implement the change');
    expect(html).not.toContain('Issue');
  });

  test('a run with no branch of its own names the base it works from', () => {
    const html = render({ ...itemRun, progress: progressOf({ branch: null }) }, true);

    expect(html).toContain('from dev');
  });

  test('a paused card offers the log but no cancel', () => {
    const html = render({ ...itemRun, status: 'paused' }, true);

    expect(html).toContain('href="/console/r/0f3a9c1e-run"');
    expect(html).not.toContain('Cancel');
  });

  test('a run goes quiet once it has recorded nothing for ten minutes', () => {
    const observed = (minutes: number): Run => ({
      ...itemRun,
      progress: progressOf({ last_observed_at: minutesAgo(minutes) }),
    });

    const active = render(observed(9), true);
    expect(active).toContain('active 9m ago');
    expect(active).not.toContain('quiet');
    expect(active).not.toContain('No activity for');

    const quiet = render(observed(11));
    expect(quiet).toContain('quiet 11m');
    expect(quiet).not.toContain('active 11m ago');
    expect(quiet).not.toContain('No activity for');

    expect(render(observed(11), true)).toContain('No activity for 11m. Check the');
  });

  test('a run on no item shows its input in the item slot, and nothing when it has neither', () => {
    const noItem = render({ ...itemRun, itemKey: null }, true);
    expect(noItem).toContain('Implement the change');
    expect(noItem).not.toContain('issue-42');
    expect(noItem).not.toContain('>input<');

    const neither = render({ ...itemRun, itemKey: null, userMessage: '' });
    expect(neither).toContain('implement');
    expect(neither).not.toContain('issue-42');
    expect(neither).not.toContain('title=""');
  });

  test('a run with no agent message yet says so, and one without progress says nothing', () => {
    const noMessage = render({ ...itemRun, progress: progressOf({ last_message: null }) }, true);
    expect(noMessage).toContain('no message yet');
    expect(noMessage).not.toContain('last message');

    const noProgress = render({ ...itemRun, progress: null }, true);
    expect(noProgress).not.toContain('no message yet');
    expect(noProgress).not.toContain('last message');
    expect(noProgress).not.toContain('steps done');
    expect(noProgress).not.toContain('active ');
    expect(noProgress).toContain('Cancel');
  });

  test('a run whose origin is not known shows no origin badge', () => {
    expect(render({ ...itemRun, origin: 'unknown' }, true)).not.toContain('Origin:');
  });

  test('a run that has reported no cost shows none', () => {
    expect(render({ ...itemRun, costUsd: null }, true)).not.toContain('Reported cost');
  });
});

test('a running card displays overdue tools without offering resume', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ActiveRunCard
        run={{
          ...parallelRun,
          toolCallAttention: [
            {
              streamId: 's',
              nodeId: 'parallel-a',
              provider: 'codex',
              toolCallId: 'call',
              name: 'bash',
              title: 'bun test [REDACTED]',
              startedAt: new Date(Date.now() - 1800000).toISOString(),
              lastProgressAt: new Date(Date.now() - 1800000).toISOString(),
              raisedAt: new Date().toISOString(),
              thresholdMs: 1800000,
            },
          ],
        }}
      />
    </MemoryRouter>
  );
  expect(html).toContain('Work remains running');
  expect(html).toContain('bun test [REDACTED]');
  expect(html).toContain('no progress');
  expect(html).not.toContain('Resume');
});

test('promoting an attention wait replaces its inline actions with the banner pointer', () => {
  const run: Run = {
    ...parallelRun,
    status: 'paused',
    attention: {
      kind: 'attention',
      runId: parallelRun.id,
      nodeId: 'hold',
      message: 'Rotate the key',
      occurrence: 'legacy:hold',
      form: 'message',
      options: [],
    },
    wait: {
      kind: 'attention',
      nodeId: 'hold',
      message: 'Rotate the key',
      waitingSince: '2026-10-12T00:00:00.000Z',
    },
  };
  const promoted = renderToStaticMarkup(
    <MemoryRouter>
      <ActiveRunCard run={run} inputPromoted />
    </MemoryRouter>
  );
  expect(promoted).toContain('see the banner at the top');
  expect(promoted).not.toContain('Resume');
  const inline = renderToStaticMarkup(
    <MemoryRouter>
      <ActiveRunCard run={run} />
    </MemoryRouter>
  );
  expect(inline).toContain('Rotate the key');
  expect(inline).toContain('Resume');
});

test.each(['unreachable', 'unknown'] as const)(
  'a running card whose owner is %s keeps its status but stops looking live',
  observation => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ActiveRunCard run={{ ...parallelRun, ownerObservation: observation }} />
      </MemoryRouter>
    );

    expect(html).toContain(
      observation === 'unreachable' ? 'Running · owner not answering' : 'Running · owner unknown'
    );
    expect(html).toContain('since launch');
    expect(html).toContain('last recorded nodes');
    expect(html).not.toContain('animate-ping');
    expect(html).not.toContain('animate-pulse');
  }
);

test('a running card whose owner answers stays live', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ActiveRunCard run={{ ...parallelRun, ownerObservation: 'reachable' }} />
    </MemoryRouter>
  );

  expect(html).toContain('animate-ping');
  expect(html).not.toContain('since launch');
});
