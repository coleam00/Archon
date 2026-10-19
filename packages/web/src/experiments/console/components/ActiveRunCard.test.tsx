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
  lastTool: null,
};

describe('ActiveRunCard', () => {
  test('renders every active node for a parallel run', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ActiveRunCard run={parallelRun} />
      </MemoryRouter>
    );

    expect(html).toContain('nodes');
    expect(html).toContain('parallel-a, parallel-b');
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
        <ActiveRunCard run={{ ...parallelRun, ownerObservation: observation, lastTool: 'bash' }} />
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
