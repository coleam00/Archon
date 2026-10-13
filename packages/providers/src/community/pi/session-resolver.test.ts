import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ─── Mock SessionManager before import ─────────────────────────────────────

const mockCreate = mock((_cwd: string) => ({ __kind: 'created' }));
const mockInMemory = mock((_cwd: string) => ({ __kind: 'in-memory' }));
const mockOpen = mock((_path: string) => ({ __kind: 'opened' }));
const mockForkFrom = mock(async (_path: string, _cwd: string) => ({ __kind: 'forked' }));
const mockList = mock(async (_cwd: string) => [] as { id: string; path: string; cwd: string }[]);

mock.module('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    create: mockCreate,
    inMemory: mockInMemory,
    open: mockOpen,
    forkFrom: mockForkFrom,
    list: mockList,
  },
}));

import { resolvePiSession } from './session-resolver';

describe('resolvePiSession', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockInMemory.mockClear();
    mockOpen.mockClear();
    mockForkFrom.mockClear();
    mockList.mockClear();
    mockList.mockImplementation(async () => []);
  });

  test('no resumeSessionId → create fresh session', async () => {
    const result = await resolvePiSession('/tmp/proj', undefined);
    expect(result.resumeFailed).toBe(false);
    expect(mockCreate).toHaveBeenCalledWith('/tmp/proj');
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockInMemory).not.toHaveBeenCalled();
  });

  test('ephemeral request without resume → in-memory session', async () => {
    const result = await resolvePiSession('/tmp/proj', undefined, false, true);
    expect(result.resumeFailed).toBe(false);
    expect<unknown>(result.sessionManager).toBe(mockInMemory.mock.results[0].value);
    expect(mockInMemory).toHaveBeenCalledWith('/tmp/proj');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  test('explicit non-ephemeral request → persistent session', async () => {
    await resolvePiSession('/tmp/proj', undefined, false, false);
    expect(mockCreate).toHaveBeenCalledWith('/tmp/proj');
    expect(mockInMemory).not.toHaveBeenCalled();
  });

  test('resume id matches existing session → open by path', async () => {
    mockList.mockImplementationOnce(async () => [
      { id: 'abc-123', path: '/sessions/abc-123.jsonl', cwd: '/tmp/proj' },
      { id: 'def-456', path: '/sessions/def-456.jsonl', cwd: '/tmp/proj' },
    ]);

    const result = await resolvePiSession('/tmp/proj', 'def-456', false, true);
    expect(result.resumeFailed).toBe(false);
    expect(mockOpen).toHaveBeenCalledWith('/sessions/def-456.jsonl');
    expect(mockForkFrom).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('fork request matches existing session → fork by path without opening source', async () => {
    mockList.mockImplementationOnce(async () => [
      { id: 'abc-123', path: '/sessions/abc-123.jsonl', cwd: '/tmp/proj' },
    ]);

    const result = await resolvePiSession('/tmp/proj', 'abc-123', true, true);
    expect(result.resumeFailed).toBe(false);
    expect(mockForkFrom).toHaveBeenCalledWith('/sessions/abc-123.jsonl', '/tmp/proj');
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resume id not found → fresh session with resumeFailed=true', async () => {
    mockList.mockImplementationOnce(async () => [
      { id: 'abc-123', path: '/sessions/abc-123.jsonl', cwd: '/tmp/proj' },
    ]);

    const result = await resolvePiSession('/tmp/proj', 'missing-id', true, true);
    expect(result.resumeFailed).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith('/tmp/proj');
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockForkFrom).not.toHaveBeenCalled();
  });

  test('list() throws ENOENT → treated as not-found, fresh session', async () => {
    mockList.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('no such directory'), { code: 'ENOENT' });
      throw err;
    });

    const result = await resolvePiSession('/tmp/proj', 'some-id');
    expect(result.resumeFailed).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith('/tmp/proj');
  });

  test('list() throws ENOTDIR → treated as not-found, fresh session', async () => {
    mockList.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      throw err;
    });

    const result = await resolvePiSession('/tmp/proj', 'some-id');
    expect(result.resumeFailed).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith('/tmp/proj');
  });

  test('list() throws unexpected error → propagates (no silent fallback)', async () => {
    // Permission errors, parse failures, etc. must NOT be swallowed as
    // "no resume" — that would paper over real config/filesystem problems.
    mockList.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      throw err;
    });

    await expect(resolvePiSession('/tmp/proj', 'some-id')).rejects.toThrow(/permission denied/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('list() throws plain Error → propagates (no code = not ENOENT)', async () => {
    mockList.mockImplementationOnce(async () => {
      throw new Error('some other failure');
    });

    await expect(resolvePiSession('/tmp/proj', 'some-id')).rejects.toThrow(/some other failure/);
  });

  test('empty resumeSessionId string → fresh session (no resume attempted)', async () => {
    // Treated as "no resume requested" by the truthy check in the resolver.
    const result = await resolvePiSession('/tmp/proj', '');
    expect(result.resumeFailed).toBe(false);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();
  });
});
