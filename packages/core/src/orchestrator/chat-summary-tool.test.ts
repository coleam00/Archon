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
  test('writes the summary and does not claim the user wrote it', async () => {
    const out = await call({ summary: 'Fixing the refund job. Half done.' });
    expect(out).toContain('Summary updated');
    const [id, brief, pinned] = mockUpdate.mock.calls.at(-1) as unknown as [
      string,
      string,
      boolean,
    ];
    expect(id).toBe('conv-1');
    expect(brief).toBe('Fixing the refund job. Half done.');
    // The agent writing must never set the pin, or it would lock itself out.
    expect(pinned).toBe(false);
  });

  test('leaves a summary the user edited alone', async () => {
    mockFind.mockResolvedValue({ id: 'conv-1', brief_pinned: true, brief: 'Mine.' });
    const out = await call({ summary: 'Something else.' });
    expect(out).toContain('the user edited this summary');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('clearing works even on a pinned summary, since it is explicit', async () => {
    mockFind.mockResolvedValue({ id: 'conv-1', brief_pinned: true, brief: 'Mine.' });
    const out = await call({ clear: true });
    expect(out).toBe('Summary cleared.');
    expect(mockUpdate.mock.calls.at(-1)?.[1]).toBeNull();
  });

  test('refuses an empty summary rather than blanking the field', async () => {
    const out = await call({ summary: '   ' });
    expect(out).toContain('is required');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('reports a conversation that no longer exists instead of throwing', async () => {
    mockFind.mockResolvedValue(null);
    const out = await call({ summary: 'anything' });
    expect(out).toContain('no longer exists');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('truncates rather than letting an over-long summary fail the write', async () => {
    await call({ summary: 'x'.repeat(5000) });
    expect((mockUpdate.mock.calls.at(-1)?.[1] as string).length).toBe(2000);
  });

  test('the description tells the agent when NOT to call it', () => {
    // The staleness signal is only meaningful if the tool is not called every
    // turn, so that instruction lives in the description the model reads.
    expect(tool.description).toContain('NOT on every turn');
  });
});
