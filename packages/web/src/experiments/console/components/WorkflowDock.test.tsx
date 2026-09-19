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
  conversationId: 'conv-parallel',
  conversationPlatformId: 'web-parallel',
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
          <WorkflowDock projectId="project-parallel" conversationDbId="conv-parallel" />
        </MemoryRouter>
      );

      expect(html).toContain('nodes:');
      expect(html).toContain('parallel-a, parallel-b');
    } finally {
      invalidate(cacheKey);
    }
  });
});

describe('WorkflowDock — a run belongs to the chat that started it', () => {
  const seed = (runs: Run[], key: string): void => {
    set(K.runs(key), {
      runs,
      counts: {
        all: runs.length,
        running: runs.length,
        paused: 0,
        failed: 0,
        completed: 0,
        cancelled: 0,
        pending: 0,
      },
      total: runs.length,
    });
  };
  const render = (key: string, conversationDbId: string | null): string =>
    renderToStaticMarkup(
      <MemoryRouter>
        <WorkflowDock projectId={key} conversationDbId={conversationDbId} />
      </MemoryRouter>
    );

  test('a run from another chat is not shown', () => {
    const key = 'project-scoped';
    seed([{ ...parallelRun, id: 'run-other', conversationId: 'conv-other' }], key);
    try {
      expect(render(key, 'conv-mine')).toBe('');
    } finally {
      invalidate(K.runs(key));
    }
  });

  test('a run from this chat is shown', () => {
    const key = 'project-mine';
    seed([{ ...parallelRun, id: 'run-mine', conversationId: 'conv-mine' }], key);
    try {
      expect(render(key, 'conv-mine')).toContain('parallel-a');
    } finally {
      invalidate(K.runs(key));
    }
  });

  test('a run started outside any chat is shown in none', () => {
    // CLI and webhook runs have no conversation; attributing them to whichever
    // chat happens to be open would claim work that chat never asked for.
    const key = 'project-cli';
    seed([{ ...parallelRun, id: 'run-cli', conversationId: null }], key);
    try {
      expect(render(key, 'conv-mine')).toBe('');
      expect(render(key, null)).toBe('');
    } finally {
      invalidate(K.runs(key));
    }
  });
});
