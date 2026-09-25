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
  startedAt: '2026-09-01T10:00:00.000Z',
  finishedAt: null,
  workingPath: null,
  userMessage: 'Implement the change',
  activeNodes: ['parallel-a', 'parallel-b'],
  currentNode: null,
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
