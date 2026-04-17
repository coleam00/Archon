import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ─── Mock SessionManager before import ─────────────────────────────────────

const mockCreate = mock((_cwd: string) => ({ __kind: 'created' }));
const mockOpen = mock((_path: string) => ({ __kind: 'opened' }));
const mockList = mock(async (_cwd: string) => [] as { id: string; path: string; cwd: string }[]);

mock.module('@mariozechner/pi-coding-agent', () => ({
  SessionManager: {
    create: mockCreate,
    open: mockOpen,
    list: mockList,
  },
}));

import { resolvePiSession } from './session-resolver';

describe('resolvePiSession', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockOpen.mockClear();
    mockList.mockClear();
    mockList.mockImplementation(async () => []);
  });

  test('no resumeSessionId → create fresh session', async () => {
    const result = await resolvePiSession('/tmp/proj', undefined);
    expect(result.resumeFailed).toBe(false);
    expect(mockCreate).toHaveBeenCalledWith('/tmp/proj');
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  test('resume id matches existing session → open by path', async () => {
    mockList.mockImplementationOnce(async () => [
      { id: 'abc-123', path: '/sessions/abc-123.jsonl', cwd: '/tmp/proj' },
      { id: 'def-456', path: '/sessions/def-456.jsonl', cwd: '/tmp/proj' },
    ]);

    const result = await resolvePiSession('/tmp/proj', 'def-456');
    expect(result.resumeFailed).toBe(false);
    expect(mockOpen).toHaveBeenCalledWith('/sessions/def-456.jsonl');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resume id not found → fresh session with resumeFailed=true', async () => {
    mockList.mockImplementationOnce(async () => [
      { id: 'abc-123', path: '/sessions/abc-123.jsonl', cwd: '/tmp/proj' },
    ]);

    const result = await resolvePiSession('/tmp/proj', 'missing-id');
    expect(result.resumeFailed).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith('/tmp/proj');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test('list() throws → treated as not-found, fresh session', async () => {
    mockList.mockImplementationOnce(async () => {
      throw new Error('ENOENT');
    });

    const result = await resolvePiSession('/tmp/proj', 'some-id');
    expect(result.resumeFailed).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith('/tmp/proj');
  });

  test('empty resumeSessionId string → fresh session (no resume attempted)', async () => {
    // Treated as "no resume requested" by the truthy check in the resolver.
    const result = await resolvePiSession('/tmp/proj', '');
    expect(result.resumeFailed).toBe(false);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();
  });
});
