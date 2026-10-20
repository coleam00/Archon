import {
  mockDispose,
  mockSessionCreate,
  mockSessionOpen,
  mockSessionForkFrom,
  mockSessionList,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { describe, expect, test } from 'bun:test';
import { PiProvider } from './provider';
describe('PiProvider sessions', () => {
  test('resumeSessionId not found → fresh session + pi.resume_failed warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSessionList.mockImplementationOnce(async () => []);
    resetScript(scriptedAgentEnd());

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'nonexistent-id', {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    // Resume attempted: list() called; no match → create() called (fresh session)
    expect(mockSessionList).toHaveBeenCalled();
    expect(mockSessionCreate).toHaveBeenCalledWith('/tmp');
    expect(mockSessionOpen).not.toHaveBeenCalled();
    // Resume failure surfaces as a warning
    const warnings = chunks.filter(
      (c): c is { type: 'warning'; code: string; message: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'warning'
    );
    expect(
      warnings.some(c => c.code === 'pi.resume_failed' && c.message.includes('Could not resume'))
    ).toBe(true);
    // ...and as resumed:false on the result chunk so the executor can surface it.
    expect(chunks.find(c => (c as { type?: string }).type === 'result')).toMatchObject({
      resumed: false,
    });
  });

  test('resumeSessionId matches existing session → open by path, no warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSessionList.mockImplementationOnce(async () => [
      { id: 'existing-id', path: '/sessions/existing-id.jsonl', cwd: '/tmp' },
    ]);
    resetScript(scriptedAgentEnd());

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'existing-id', {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    expect(mockSessionOpen).toHaveBeenCalledWith('/sessions/existing-id.jsonl');
    expect(mockSessionForkFrom).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
    // No resume_failed warning
    const warnings = chunks.filter(
      (c): c is { type: 'warning'; code: string; message: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'warning'
    );
    expect(
      warnings.some(c => c.code === 'pi.resume_failed' && c.message.includes('Could not resume'))
    ).toBe(false);
    // A warm resume reports resumed:true on the result chunk.
    expect(chunks.find(c => (c as { type?: string }).type === 'result')).toMatchObject({
      resumed: true,
    });
  });

  test('forkSession resumes into a distinct branch without opening the source', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSessionList.mockImplementationOnce(async () => [
      { id: 'source-id', path: '/sessions/source-id.jsonl', cwd: '/tmp' },
    ]);
    resetScript(scriptedAgentEnd());

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'source-id', {
        model: 'google/gemini-2.5-pro',
        forkSession: true,
      })
    );

    expect(error).toBeUndefined();
    expect(mockSessionForkFrom).toHaveBeenCalledWith('/sessions/source-id.jsonl', '/tmp');
    expect(mockSessionOpen).not.toHaveBeenCalled();
    expect(chunks.find(c => (c as { type?: string }).type === 'result')).toMatchObject({
      resumed: true,
      sessionId: 'mock-session-uuid',
    });
  });

  test('result chunk carries Pi sessionId (for Archon to store and reuse)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const resultChunk = chunks.find(
      (c): c is { type: 'result'; sessionId?: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunk).toBeDefined();
    expect(resultChunk?.sessionId).toBe('mock-session-uuid');
  });

  test('disposes session after completion', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});
