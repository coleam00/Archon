import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { Run } from '../primitives/run';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { WorkflowDock } from './WorkflowDock';

const parallelRun: Run = {
  id: 'run-parallel',
  projectId: 'project-parallel',
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

describe('WorkflowDock', () => {
  test('renders every active node for a parallel run', () => {
    const cacheKey = K.runs('project-parallel');
    set(cacheKey, {
      runs: [parallelRun],
      counts: {
        all: 1,
        running: 1,
        paused: 0,
        failed: 0,
        completed: 0,
        cancelled: 0,
        pending: 0,
      },
      total: 1,
    });

    try {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <WorkflowDock projectId="project-parallel" />
        </MemoryRouter>
      );

      expect(html).toContain('nodes:');
      expect(html).toContain('parallel-a, parallel-b');
    } finally {
      invalidate(cacheKey);
    }
  });
});
