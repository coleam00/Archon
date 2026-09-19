import { describe, test, expect, mock, beforeEach } from 'bun:test';

const mockFind = mock(
  async (_id: string) => null as null | { id: string; brief_pinned: boolean; brief: string | null }
);
const mockUpdate = mock(async (_id: string, _brief: string | null, _pinned: boolean) => {});

mock.module('../db/conversations', () => ({
  getConversationById: mockFind,
  updateConversationBrief: mockUpdate,
}));

const { buildChatSummaryTool } = await import('./chat-summary-tool');

const tool = buildChatSummaryTool({ conversationDbId: 'conv-1' });
const call = (input: Record<string, unknown>): Promise<string> =>
  tool.handler(input) as Promise<string>;

beforeEach(() => {
  mockFind.mockReset();
  mockUpdate.mockReset();
  mockFind.mockResolvedValue({ id: 'conv-1', brief_pinned: false, brief: null });
});

describe('update_chat_summary', () => {
  const written = (): string | null => mockUpdate.mock.calls.at(-1)?.[1] as string | null;

  test('writes the three parts and does not claim the user wrote it', async () => {
    const out = await call({
      doing: 'Fixing the refund job.',
      where: 'Half done.',
      left: 'Deploy it.',
    });
    expect(out).toContain('Summary updated');
    const [id, brief, pinned] = mockUpdate.mock.calls.at(-1) as unknown as [
      string,
      string,
      boolean,
    ];
    expect(id).toBe('conv-1');
    expect(JSON.parse(brief)).toEqual({
      doing: 'Fixing the refund job.',
      where: 'Half done.',
      left: 'Deploy it.',
    });
    // The agent writing must never set the pin, or it would lock itself out.
    expect(pinned).toBe(false);
  });

  test('a part the agent left out is stored empty, not undefined', async () => {
    await call({ doing: 'Fixing the refund job.' });
    expect(JSON.parse(written() as string)).toEqual({
      doing: 'Fixing the refund job.',
      where: '',
      left: '',
    });
  });

  test('one part is enough — a throwaway chat needs no skeleton', async () => {
    const out = await call({ where: 'Answered, nothing to build.' });
    expect(out).toContain('Summary updated');
    expect(JSON.parse(written() as string).where).toBe('Answered, nothing to build.');
  });

  test('a call in the older single-field shape still lands somewhere readable', async () => {
    await call({ summary: 'Fixing the refund job. Half done.' });
    expect(JSON.parse(written() as string).doing).toBe('Fixing the refund job. Half done.');
  });

  test('the three fields win over the deprecated one', async () => {
    await call({ doing: 'The real one.', summary: 'The old one.' });
    expect(JSON.parse(written() as string).doing).toBe('The real one.');
  });

  test('leaves a summary the user edited alone', async () => {
    mockFind.mockResolvedValue({ id: 'conv-1', brief_pinned: true, brief: 'Mine.' });
    const out = await call({ doing: 'Something else.' });
    expect(out).toContain('the user edited this summary');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('the user asking for a rewrite overrides the pin', async () => {
    mockFind.mockResolvedValue({ id: 'conv-1', brief_pinned: true, brief: 'Mine.' });
    const out = await call({ doing: 'The rewrite they asked for.', rewrite_pinned: true });
    expect(out).toContain('Summary updated');
    expect(JSON.parse(written() as string).doing).toBe('The rewrite they asked for.');
  });

  test('a rewrite does not claim the user wrote the new words', async () => {
    mockFind.mockResolvedValue({ id: 'conv-1', brief_pinned: true, brief: 'Mine.' });
    await call({ doing: 'Not theirs.', rewrite_pinned: true });
    expect(mockUpdate.mock.calls.at(-1)?.[2]).toBe(false);
  });

  test('the refusal names the way past it, so the pin is not a dead end', async () => {
    mockFind.mockResolvedValue({ id: 'conv-1', brief_pinned: true, brief: 'Mine.' });
    // Without this the only route was clear-then-write, which destroys the
    // summary in between — an interrupted rewrite would leave nothing.
    expect(await call({ doing: 'x' })).toContain('rewrite_pinned');
  });

  test('clearing works even on a pinned summary, since it is explicit', async () => {
    mockFind.mockResolvedValue({ id: 'conv-1', brief_pinned: true, brief: 'Mine.' });
    const out = await call({ clear: true });
    expect(out).toBe('Summary cleared.');
    expect(written()).toBeNull();
  });

  test('refuses an empty call rather than blanking the field', async () => {
    const out = await call({ doing: '   ', where: '', left: '\n' });
    expect(out).toContain('at least one');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('refuses a call with no fields at all', async () => {
    const out = await call({});
    expect(out).toContain('at least one');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('reports a conversation that no longer exists instead of throwing', async () => {
    mockFind.mockResolvedValue(null);
    const out = await call({ doing: 'anything' });
    expect(out).toContain('no longer exists');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('truncates each part so three long ones cannot overflow the column', async () => {
    await call({ doing: 'x'.repeat(5000), where: 'y'.repeat(5000), left: 'z'.repeat(5000) });
    const brief = JSON.parse(written() as string) as Record<string, string>;
    expect(brief.doing.length).toBe(600);
    expect(brief.where.length).toBe(600);
    expect(brief.left.length).toBe(600);
    expect((written() as string).length).toBeLessThanOrEqual(2000);
  });

  test('escaping cannot push the payload over the bound', async () => {
    // Every quote serializes as two characters, so a per-part character cap
    // alone would let this through and the write would be rejected.
    await call({ doing: '"'.repeat(600), where: '"'.repeat(600), left: '"'.repeat(600) });
    expect((written() as string).length).toBeLessThanOrEqual(2000);
  });

  test('non-string parts are dropped rather than stored as [object Object]', async () => {
    await call({ doing: 'Real.', where: { a: 1 }, left: 7 });
    expect(JSON.parse(written() as string)).toEqual({ doing: 'Real.', where: '', left: '' });
  });

  test('the description tells the agent when NOT to call it', () => {
    // The staleness signal is only meaningful if the tool is not called every
    // turn, so that instruction lives in the description the model reads.
    expect(tool.description).toContain('NOT on every turn');
  });
});
