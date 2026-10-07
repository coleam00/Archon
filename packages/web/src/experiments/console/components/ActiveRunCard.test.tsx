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
