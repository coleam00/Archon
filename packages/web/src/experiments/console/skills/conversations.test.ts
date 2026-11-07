import { afterEach, expect, test } from 'bun:test';
import { HttpError } from '../lib/http';
import { createConversation, listConversations, sendMessage } from './conversations';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

test('creates and lists project chats with generated inputs and platform ids', async () => {
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ codebaseId: 'p/1', message: 'hello' });
      return Promise.resolve(Response.json({ conversationId: 'web-1', id: 'db-1' }));
    }
    return Promise.resolve(
      Response.json([
        {
          id: 'db-1',
          platform_conversation_id: 'web-1',
          platform_type: 'web',
          title: null,
          last_activity_at: null,
        },
      ])
    );
  }) as typeof fetch;
  expect(await createConversation('p/1', 'hello')).toEqual({ conversationId: 'web-1', id: 'db-1' });
  expect(await listConversations('p/1')).toEqual([
    { id: 'web-1', platformType: 'web', title: null, lastActivityAt: null },
  ]);
  expect(calls).toEqual(['/api/conversations', '/api/conversations?codebaseId=p%2F1&mine=true']);
});

test('sends JSON messages and multipart messages with multiple browser files', async () => {
  const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
  let index = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe('/api/conversations/web%2F1%25/message');
    expect(init?.method).toBe('POST');
    if (index++ === 0) {
      expect(JSON.parse(String(init?.body))).toEqual({ message: 'hello' });
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    } else {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error('Expected multipart');
      expect(form.get('message')).toBe('hello');
      expect(
        form.getAll('files').map(file => (typeof file === 'string' ? file : file.name))
      ).toEqual(['a.txt', 'b.txt']);
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
    }
    return Promise.resolve(Response.json({ accepted: true, status: 'started' }));
  }) as typeof fetch;
  await sendMessage('web/1%', 'hello');
  await sendMessage('web/1%', 'hello', files);
});

for (const [body, expected] of [
  [JSON.stringify({ error: 'refused' }), 'refused'],
  [JSON.stringify({ error: 42 }), '{"error":42}'],
  ['<html>proxy</html>', '<html>proxy</html>'],
  ['', 'HTTP 400'],
  ['x'.repeat(250), `${'x'.repeat(200)}...`],
]) {
  test(`preserves multipart failure detail: ${expected.slice(0, 30)}`, async () => {
    globalThis.window = { location: { origin: 'http://localhost' } } as Window & typeof globalThis;
    globalThis.fetch = Object.assign(() => Promise.resolve(new Response(body, { status: 400 })), {
      preconnect: originalFetch.preconnect,
    });
    await expect(sendMessage('web-1', 'hello', [new File(['a'], 'a.txt')])).rejects.toMatchObject({
      name: HttpError.name,
      status: 400,
      path: '/api/conversations/web-1/message',
      bodySnippet: expected,
    });
  });
}
