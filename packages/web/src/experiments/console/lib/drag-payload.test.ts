import { describe, expect, test } from 'bun:test';
import { encodeDragPayload, decodeDragPayload, type DragPayload } from './drag-payload';
import type { Run } from '../primitives/run';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-abc-123',
    projectId: 'proj-xyz',
    projectName: 'my-project',
    costUsd: null,
    conversationId: null,
    conversationPlatformId: null,
    workflow: 'implement',
    origin: 'web',
    status: 'completed',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    workingPath: null,
    userMessage: 'Add dark mode support',
    ...overrides,
  };
}

describe('encodeDragPayload', () => {
  test('encodes required fields as JSON', () => {
    const run = makeRun();
    const raw = encodeDragPayload(run);
    const parsed = JSON.parse(raw) as DragPayload;
    expect(parsed.runId).toBe('run-abc-123');
    expect(parsed.projectId).toBe('proj-xyz');
    expect(parsed.workflow).toBe('implement');
    expect(parsed.message).toBe('Add dark mode support');
  });

  test('uses userMessage as message', () => {
    const run = makeRun({ userMessage: 'Fix the bug' });
    const raw = encodeDragPayload(run);
    const parsed = JSON.parse(raw) as DragPayload;
    expect(parsed.message).toBe('Fix the bug');
  });

  test('null projectId is encoded as-is', () => {
    const run = makeRun({ projectId: null });
    const raw = encodeDragPayload(run);
    const parsed = JSON.parse(raw) as unknown;
    expect((parsed as Record<string, unknown>).projectId).toBeNull();
  });
});

describe('decodeDragPayload', () => {
  test('round-trips encode → decode', () => {
    const run = makeRun();
    const payload = decodeDragPayload(encodeDragPayload(run));
    expect(payload).not.toBeNull();
    expect(payload!.runId).toBe(run.id);
    expect(payload!.projectId).toBe(run.projectId);
    expect(payload!.workflow).toBe(run.workflow);
    expect(payload!.message).toBe(run.userMessage);
  });

  test('returns null for invalid JSON', () => {
    expect(decodeDragPayload('not json {')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(decodeDragPayload('')).toBeNull();
  });

  test('returns null when runId is missing', () => {
    const raw = JSON.stringify({ projectId: 'p', workflow: 'implement', message: 'hi' });
    expect(decodeDragPayload(raw)).toBeNull();
  });

  test('returns null when projectId is missing', () => {
    const raw = JSON.stringify({ runId: 'r', workflow: 'implement', message: 'hi' });
    expect(decodeDragPayload(raw)).toBeNull();
  });

  test('returns null when workflow is a number', () => {
    const raw = JSON.stringify({ runId: 'r', projectId: 'p', workflow: 42, message: 'hi' });
    expect(decodeDragPayload(raw)).toBeNull();
  });

  test('returns null for null input', () => {
    expect(decodeDragPayload('null')).toBeNull();
  });

  test('returns null for array input', () => {
    expect(decodeDragPayload('[]')).toBeNull();
  });
});
