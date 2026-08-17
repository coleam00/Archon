import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { OllamaProvider } from './provider';
import { OllamaClient, ollamaEventContent, resolveOllamaBaseUrl, type FetchFn } from './client';
import { UnknownOllamaModelError } from './errors';
import { OLLAMA_CAPABILITIES } from './capabilities';

/** Build an NDJSON stream Response from an array of JSON-line objects. */
function ndjsonResponse(events: unknown[], status = 200): Response {
  const body = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  const encoded = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

/**
 * Recorder fetch implementation — counts calls AND delegates to a swappable
 * underlying implementation. Tests call `rec.setFetch(...)` to install a
 * per-test response shape without losing the call log.
 */
type Recorder = {
  fetch: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
  setFetch: (impl: FetchFn) => void;
};
function recorder(): Recorder {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let active: FetchFn = (async () => ndjsonResponse([])) as FetchFn;
  const rec: Recorder = {
    fetch: undefined as unknown as FetchFn,
    calls,
    setFetch: (impl: FetchFn) => {
      active = impl;
    },
  };
  rec.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: url as string, init });
    return active(url as string, init);
  }) as FetchFn;
  return rec;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('ollama/capabilities', () => {
  it('declares the documented capability vector', () => {
    expect(OLLAMA_CAPABILITIES.sessionResume).toBe(false);
    expect(OLLAMA_CAPABILITIES.mcp).toBe(false);
    expect(OLLAMA_CAPABILITIES.hooks).toBe(false);
    expect(OLLAMA_CAPABILITIES.skills).toBe(false);
    expect(OLLAMA_CAPABILITIES.agents).toBe(false);
    expect(OLLAMA_CAPABILITIES.toolRestrictions).toBe(false);
    expect(OLLAMA_CAPABILITIES.structuredOutput).toBe('best-effort');
    expect(OLLAMA_CAPABILITIES.envInjection).toBe(true);
    expect(OLLAMA_CAPABILITIES.costControl).toBe(false);
    expect(OLLAMA_CAPABILITIES.effortControl).toBe(false);
    expect(OLLAMA_CAPABILITIES.thinkingControl).toBe(false);
    expect(OLLAMA_CAPABILITIES.fallbackModel).toBe(false);
    expect(OLLAMA_CAPABILITIES.sandbox).toBe(false);
    expect(OLLAMA_CAPABILITIES.nativeTools).toBe(false);
    expect(OLLAMA_CAPABILITIES.containerExec).toBe(false);
    expect(OLLAMA_CAPABILITIES.settingSources).toBe(false);
  });
});

describe('ollama/client', () => {
  describe('resolveOllamaBaseUrl', () => {
    beforeEach(() => {
      delete process.env.OLLAMA_BASE_URL;
    });

    it('returns the default when nothing is configured', () => {
      expect(resolveOllamaBaseUrl(undefined)).toBe('http://localhost:11434');
    });

    it('honours process.env.OLLAMA_BASE_URL when no override supplied', () => {
      process.env.OLLAMA_BASE_URL = 'http://100.66.140.50:11434/';
      expect(resolveOllamaBaseUrl(undefined)).toBe('http://100.66.140.50:11434');
    });

    it('honours the explicit override (per-call, highest precedence)', () => {
      process.env.OLLAMA_BASE_URL = 'http://from-process-env:11434/';
      expect(resolveOllamaBaseUrl('http://from-call:11434')).toBe(
        'http://from-call:11434'
      );
    });

    it('strips trailing slashes', () => {
      expect(resolveOllamaBaseUrl('http://example:11434////')).toBe(
        'http://example:11434'
      );
    });
  });

  describe('chat', () => {
    it('Case A: parses NDJSON legacy "response" deltas into chat events (kept for back-compat)', async () => {
      const rec = recorder();
      rec.setFetch(
        (async () =>
          ndjsonResponse([
            { response: 'hello' },
            { response: 'world' },
            { done: true, model: 'internlm/internlm2.5:7b-8k' },
          ])) as FetchFn
      );

      const client = new OllamaClient({ fetchFn: rec.fetch });
      const events = await collect(
        client.chat({ model: 'internlm/internlm2.5:7b-8k', prompt: 'hi' })
      );

      expect(events.length).toBe(3);
      expect(events[0]).toEqual({ response: 'hello' });
      expect(events[1]).toEqual({ response: 'world' });
      expect(events[2]).toEqual({
        done: true,
        model: 'internlm/internlm2.5:7b-8k',
      });
    });

    it('Case D: parses NDJSON in Ollama-live shape: {message:{role,content}} — verified against 100.66.140.50:11434', async () => {
      // This is the exact wire format /api/chat streams today (proven by
      // `curl -N -X POST ... -d '{"stream":true,...}'` on the operator's
      // shin-blackmamba:11434, captured 2026-08-17). The previous test
      // surface used {response:'x'} because the implementation was patterned
      // against AiderDesk's SSE shape; Ollama's /api/chat does not emit
      // `{response}` at all.
      const rec = recorder();
      rec.setFetch(
        (async () =>
          ndjsonResponse([
            {
              model: 'internlm/internlm2.5:7b-8k',
              created_at: '2026-08-17T19:13:06.148Z',
              message: { role: 'assistant', content: 'Sure' },
              done: false,
            },
            {
              model: 'internlm/internlm2.5:7b-8k',
              created_at: '2026-08-17T19:13:06.222Z',
              message: { role: 'assistant', content: ',' },
              done: false,
            },
            {
              model: 'internlm/internlm2.5:7b-8k',
              created_at: '2026-08-17T19:13:07.000Z',
              message: { role: 'assistant', content: " what's your" },
              done: false,
            },
            {
              model: 'internlm/internlm2.5:7b-8k',
              total_duration: 1676956389,
              done_reason: 'stop',
              message: { role: 'assistant', content: '' },
              done: true,
            },
          ])) as FetchFn
      );

      const client = new OllamaClient({ fetchFn: rec.fetch });
      const events = await collect(
        client.chat({ model: 'internlm/internlm2.5:7b-8k', prompt: 'hi' })
      );

      // Sanity: NDJSON parser yields all 4 events.
      expect(events.length).toBe(4);
      // The terminal event has done:true.
      expect(events[3].done).toBe(true);
      // The terminal-event message content is empty (Ollama convention); the
      // earlier three carry the streamed delta strings exactly as the
      // operator's wire trace shows.
      expect(events[0].message?.content).toBe('Sure');
      expect(events[1].message?.content).toBe(',');
      expect(events[2].message?.content).toBe(" what's your");
    });

    it('ollamaEventContent: prefers message.content, falls back to flat response, returns null otherwise', () => {
      expect(
        ollamaEventContent({ message: { role: 'assistant', content: 'a' } })
      ).toBe('a');
      expect(ollamaEventContent({ response: 'b' })).toBe('b');
      expect(
        ollamaEventContent({
          message: { role: 'assistant', content: 'live' },
          response: 'legacy',
        })
      ).toBe('live'); // live wins
      expect(ollamaEventContent({ done: true })).toBeNull();
      expect(ollamaEventContent({ message: { content: '' } })).toBeNull();
      expect(ollamaEventContent({ response: '' })).toBeNull();
    });

    it('Case B: non-2xx response → throws UnknownOllamaModelError with body snippet', async () => {
      const rec = recorder();
      rec.setFetch(
        (async () =>
          new Response('model "broken" not found, try pulling it', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          })) as FetchFn
      );

      const client = new OllamaClient({ fetchFn: rec.fetch });

      await expect(
        collect(client.chat({ model: 'broken', prompt: 'hi' }))
      ).rejects.toThrow(UnknownOllamaModelError);

      // Second call so we can inspect the typed fields without try-catch noise.
      try {
        await collect(client.chat({ model: 'broken', prompt: 'hi' }));
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownOllamaModelError);
        expect((error as UnknownOllamaModelError).model).toBe('broken');
        expect((error as UnknownOllamaModelError).bodySnippet).toContain('not found');
      }
    });

    it('Case C: per-call baseUrl leaks into the POST URL', async () => {
      const rec = recorder();
      const client = new OllamaClient({
        fetchFn: rec.fetch,
        baseUrl: 'http://per-call-override:11434/',
      });

      await collect(client.chat({ model: 'm', prompt: 'hi' }));

      expect(rec.calls.length).toBe(1);
      expect(rec.calls[0].url).toBe('http://per-call-override:11434/api/chat');
    });

    it('sends a single-message chat body with stream:true', async () => {
      const rec = recorder();
      rec.setFetch((async () => ndjsonResponse([{ response: 'ok', done: true }])) as FetchFn);

      const client = new OllamaClient({ fetchFn: rec.fetch });
      await collect(client.chat({ model: 'm', prompt: 'hello' }));

      expect(rec.calls.length).toBe(1);
      const body = JSON.parse(rec.calls[0].init!.body as string);
      expect(body.model).toBe('m');
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(body.stream).toBe(true);
    });
  });
});

describe('OllamaProvider', () => {
  it('getType returns "ollama"', () => {
    expect(new OllamaProvider().getType()).toBe('ollama');
  });

  it('getCapabilities returns OLLAMA_CAPABILITIES', () => {
    expect(new OllamaProvider().getCapabilities()).toBe(OLLAMA_CAPABILITIES);
  });

  it('yields assistant chunks then a final result chunk', async () => {
    const rec = recorder();
    rec.setFetch(
      (async () =>
        ndjsonResponse([{ response: 'hello' }, { response: 'world' }, { done: true }])) as FetchFn
    );

    const provider = new OllamaProvider({ fetchFn: rec.fetch });
    const chunks = await collect(
      provider.sendQuery('hi', '/test', undefined, {
        model: 'internlm/internlm2.5:7b-8k',
        env: { OLLAMA_BASE_URL: 'http://localhost:11434/' },
      })
    );

    const assistants = chunks.filter(
      c => (c as { type: string }).type === 'assistant'
    ) as Array<{ type: 'assistant'; content: string }>;
    expect(assistants.map(a => a.content)).toEqual(['hello', 'world']);

    const resultChunk = chunks.find(
      c => (c as { type: string }).type === 'result'
    ) as
      | {
          type: 'result';
          isError?: boolean;
          content?: string;
          resolvedModel?: { id: string };
        }
      | undefined;
    expect(resultChunk).toBeDefined();
    expect(resultChunk!.isError).toBe(false);
    expect(resultChunk!.resolvedModel?.id).toBe('internlm/internlm2.5:7b-8k');
  });

  it('throws UnknownOllamaModelError when model is missing', async () => {
    const rec = recorder();
    const provider = new OllamaProvider({ fetchFn: rec.fetch });

    await expect(collect(provider.sendQuery('hi', '/test'))).rejects.toThrow(
      UnknownOllamaModelError
    );
  });

  it('honours abortSignal by wiring it through to fetch', async () => {
    const rec = recorder();
    let observedSignal: AbortSignal | undefined;
    rec.setFetch((async (_url: string, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal | undefined;
      return ndjsonResponse([{ done: true }]);
    }) as FetchFn);

    const controller = new AbortController();
    const provider = new OllamaProvider({ fetchFn: rec.fetch });

    const result = await collect(
      provider.sendQuery('hi', '/test', undefined, {
        model: 'm',
        env: { OLLAMA_BASE_URL: 'http://localhost:11434/' },
        abortSignal: controller.signal,
      })
    );
    expect(observedSignal).toBeDefined();
    expect(typeof observedSignal!.addEventListener).toBe('function');

    const resultChunk = result.find(
      c => (c as { type: string }).type === 'result'
    ) as { type: 'result'; isError?: boolean; stopReason?: string };
    expect(resultChunk?.isError).toBe(false);
    expect(resultChunk?.stopReason).toBe('end_turn');
  });

  it('emits end_turn result on streaming success', async () => {
    const rec = recorder();
    rec.setFetch((async () => ndjsonResponse([{ response: 'one', done: true }])) as FetchFn);

    const provider = new OllamaProvider({ fetchFn: rec.fetch });
    const chunks = await collect(
      provider.sendQuery('hi', '/test', undefined, {
        model: 'm',
        env: { OLLAMA_BASE_URL: 'http://localhost:11434/' },
      })
    );

    const result = chunks.find(
      c => (c as { type: string }).type === 'result'
    ) as { type: 'result'; stopReason?: string; isError?: boolean };
    expect(result?.stopReason).toBe('end_turn');
    expect(result?.isError).toBe(false);
  });

  it('structured output: parses JSON response when outputFormat.schema is set', async () => {
    const rec = recorder();
    rec.setFetch(
      (async () => ndjsonResponse([{ response: '{"answer":"42"}' }, { done: true }])) as FetchFn
    );

    const provider = new OllamaProvider({ fetchFn: rec.fetch });
    const chunks = await collect(
      provider.sendQuery('hi', '/test', undefined, {
        model: 'm',
        env: { OLLAMA_BASE_URL: 'http://localhost:11434/' },
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      })
    );

    const result = chunks.find(
      c => (c as { type: string }).type === 'result'
    ) as { type: 'result'; structuredOutput?: unknown };
    expect(result?.structuredOutput).toEqual({ answer: '42' });
  });
});

// Touch the mock import so the unused-symbol tree-shaker doesn't drop it.
void mock;
