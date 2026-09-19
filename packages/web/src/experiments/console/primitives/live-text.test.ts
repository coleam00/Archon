import { describe, test, expect } from 'bun:test';
import {
  reduceLive,
  pendingSegments,
  persistedSegmentCount,
  type LiveSegment,
  type LiveEvent,
} from './live-text';

const text = (content: string, category: string | null = null): LiveEvent => ({
  kind: 'text',
  content,
  category,
});
const tool: LiveEvent = { kind: 'tool' };
const retract: LiveEvent = { kind: 'retract' };

const fold = (events: LiveEvent[]): LiveSegment[] => events.reduce(reduceLive, []);

const user = (content: string): { role: string; content: string } => ({ role: 'user', content });
const assistant = (content: string): { role: string; content: string } => ({
  role: 'assistant',
  content,
});

describe('reduceLive — mirrors the server segmentation', () => {
  test('consecutive text joins one segment, as appendText concatenates', () => {
    expect(fold([text('Hello '), text('world')])).toEqual([
      { content: 'Hello world', category: null, hasTools: false },
    ]);
  });

  test('text after a tool call starts a new segment', () => {
    const segments = fold([text('before'), tool, text('after')]);
    expect(segments.map(s => s.content)).toEqual(['before', 'after']);
    expect(segments[0]?.hasTools).toBe(true);
    expect(segments[1]?.hasTools).toBe(false);
  });

  test('a standalone category gets its own bubble, and so does the text after it', () => {
    const segments = fold([
      text('narration'),
      text('🚀 dispatching', 'workflow_dispatch_status'),
      text('back to normal'),
    ]);
    expect(segments.map(s => s.content)).toEqual(['narration', '🚀 dispatching', 'back to normal']);
  });

  test('a tool call before any text opens no segment', () => {
    expect(fold([tool])).toEqual([]);
    expect(fold([tool, text('first words')]).map(s => s.content)).toEqual(['first words']);
  });

  test('is pure — the input array is not mutated', () => {
    const before: LiveSegment[] = [{ content: 'kept', category: null, hasTools: false }];
    const snapshot = structuredClone(before);
    reduceLive(before, text(' more'));
    expect(before).toEqual(snapshot);
  });
});

describe('reduceLive — retract', () => {
  test('drops the last segment, matching retractLastSegment', () => {
    const segments = fold([text('keep this'), tool, text('replace this'), retract]);
    expect(segments.map(s => s.content)).toEqual(['keep this']);
  });

  test('clears the text but keeps a segment that carries tool calls', () => {
    const segments = fold([text('spoken'), tool, retract]);
    expect(segments).toEqual([{ content: '', category: null, hasTools: true }]);
  });

  test('retracting with nothing buffered is a no-op', () => {
    expect(fold([retract])).toEqual([]);
  });
});

describe('persistedSegmentCount', () => {
  test('counts only this turn — it stops at the last user message', () => {
    const messages = [
      user('older question'),
      assistant('older answer'),
      user('current question'),
      assistant('first part'),
    ];
    expect(persistedSegmentCount(messages)).toBe(1);
  });

  test('ignores tool-only rows, which persist with empty content', () => {
    const messages = [user('go'), assistant(''), assistant('real text'), assistant('')];
    expect(persistedSegmentCount(messages)).toBe(1);
  });

  test('is zero when the turn has produced no rows yet', () => {
    expect(persistedSegmentCount([user('go')])).toBe(0);
  });
});

describe('pendingSegments — what the database has not caught up with', () => {
  test('previews everything while the buffer is unflushed', () => {
    const segments = fold([text('one'), tool, text('two')]);
    expect(pendingSegments(segments, [user('go')]).map(s => s.content)).toEqual(['one', 'two']);
  });

  test('drops the preview of a segment once its row lands — no duplicate', () => {
    const segments = fold([text('one'), tool, text('two')]);
    const messages = [user('go'), assistant('one')];
    expect(pendingSegments(segments, messages).map(s => s.content)).toEqual(['two']);
  });

  test('previews nothing once the flush has caught up completely', () => {
    const segments = fold([text('one'), tool, text('two')]);
    const messages = [user('go'), assistant('one'), assistant('two')];
    expect(pendingSegments(segments, messages)).toEqual([]);
  });

  test('a retracted segment is never previewed', () => {
    const segments = fold([text('preamble that becomes a dispatch'), retract]);
    expect(pendingSegments(segments, [user('go')])).toEqual([]);
  });

  test('omits blank segments so an empty bubble never renders', () => {
    const segments = fold([text('spoken'), tool, retract]);
    expect(pendingSegments(segments, [user('go')])).toEqual([]);
  });
});
