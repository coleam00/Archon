/**
 * Smoke test for ExecuteDropZone drop handler logic.
 *
 * Uses mock.module to replace the skills barrel before importing the component,
 * following the mock-isolation pattern required by CLAUDE.md.
 * This file must be run as a separate `bun test` invocation in package.json to
 * prevent mock.module pollution from affecting other test files that import
 * skills.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// mock.module must be called before any import that transitively loads the
// real skills module.
const mockStartRun = mock(() => Promise.resolve());

mock.module('../skills', () => ({
  startRun: mockStartRun,
}));

// Import after mock registration.
import { handleExecuteDrop } from './ExecuteDropZone';
import type { StartRunArgs } from '../skills/startRun';

beforeEach(() => {
  mockStartRun.mockClear();
});

describe('handleExecuteDrop — happy path', () => {
  test('calls startRun with workflow: implement and the run message', async () => {
    const { encodeDragPayload } = await import('../lib/drag-payload');
    const raw = encodeDragPayload({
      id: 'run-001',
      projectId: 'proj-abc',
      projectName: 'my-project',
      costUsd: null,
      conversationId: null,
      conversationPlatformId: null,
      workflow: 'plan',
      origin: 'web',
      status: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      workingPath: null,
      userMessage: 'Add dark mode',
    });

    const captured: StartRunArgs[] = [];
    const startRunSpy = mock(async (args: StartRunArgs) => {
      captured.push(args);
    });

    const dispatched = await handleExecuteDrop(raw, 'proj-abc', startRunSpy);

    expect(dispatched).toBe(true);
    expect(startRunSpy).toHaveBeenCalledTimes(1);
    expect(captured[0]).toEqual({
      projectId: 'proj-abc',
      workflow: 'implement',
      message: 'Add dark mode',
    });
  });
});

describe('handleExecuteDrop — malformed payload', () => {
  test('returns false and does NOT call startRun for invalid JSON', async () => {
    const startRunSpy = mock(async (_args: StartRunArgs) => {});
    const dispatched = await handleExecuteDrop('not json', 'proj-abc', startRunSpy);
    expect(dispatched).toBe(false);
    expect(startRunSpy).not.toHaveBeenCalled();
  });

  test('returns false and does NOT call startRun for missing fields', async () => {
    const raw = JSON.stringify({ runId: 'r', workflow: 'implement' }); // missing projectId + message
    const startRunSpy = mock(async (_args: StartRunArgs) => {});
    const dispatched = await handleExecuteDrop(raw, 'proj-abc', startRunSpy);
    expect(dispatched).toBe(false);
    expect(startRunSpy).not.toHaveBeenCalled();
  });

  test('returns false for empty string without throwing', async () => {
    const startRunSpy = mock(async (_args: StartRunArgs) => {});
    const dispatched = await handleExecuteDrop('', 'proj-abc', startRunSpy);
    expect(dispatched).toBe(false);
    expect(startRunSpy).not.toHaveBeenCalled();
  });
});

describe('handleExecuteDrop — demo run guard', () => {
  test('returns false and does NOT call startRun for demo- run ids', async () => {
    const { encodeDragPayload } = await import('../lib/drag-payload');
    const raw = encodeDragPayload({
      id: 'demo-running-1',
      projectId: 'proj-abc',
      projectName: 'demo',
      costUsd: null,
      conversationId: null,
      conversationPlatformId: null,
      workflow: 'plan',
      origin: 'web',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      workingPath: null,
      userMessage: 'demo task',
    });
    const startRunSpy = mock(async (_args: StartRunArgs) => {});
    const dispatched = await handleExecuteDrop(raw, 'proj-abc', startRunSpy);
    expect(dispatched).toBe(false);
    expect(startRunSpy).not.toHaveBeenCalled();
  });
});

describe('handleExecuteDrop — startRun rejection', () => {
  test('propagates the error when startRun rejects', async () => {
    const { encodeDragPayload } = await import('../lib/drag-payload');
    const raw = encodeDragPayload({
      id: 'run-002',
      projectId: 'proj-abc',
      projectName: 'my-project',
      costUsd: null,
      conversationId: null,
      conversationPlatformId: null,
      workflow: 'implement',
      origin: 'web',
      status: 'failed',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      workingPath: null,
      userMessage: 'Fix the bug',
    });
    const startRunSpy = mock(async (_args: StartRunArgs) => {
      throw new Error('Network error');
    });
    await expect(handleExecuteDrop(raw, 'proj-abc', startRunSpy)).rejects.toThrow('Network error');
  });
});
