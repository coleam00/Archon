import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { KIMI_CAPABILITIES } from './capabilities';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'moonshotai/kimi-k2';
const HTTP_REFERER = 'https://github.com/coleam00/archon';

/**
 * Strip ```json ... ``` fences from a string so JSON.parse works.
 */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

/**
 * Kimi K2.5 provider via OpenRouter (OpenAI-compatible chat completions API).
 *
 * Each sendQuery() call is stateless — no session resume. Designed for
 * content-generation and synthesis nodes in Archon DAGs where the task is
 * "prompt in → text out" rather than agentic tool-use.
 *
 * Auth: reads OPENROUTER_API_KEY from requestOptions.env or process.env.
 * Model: defaults to moonshotai/kimi-k2; override with requestOptions.model.
 */
export class KimiProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const apiKey = requestOptions?.env?.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        'KimiProvider requires OPENROUTER_API_KEY. Set it in the environment or in .archon/config.yaml env: section.'
      );
    }

    const model = requestOptions?.model ?? DEFAULT_MODEL;

    // Build message list
    const messages: { role: string; content: string }[] = [];

    const rawSystemPrompt = requestOptions?.systemPrompt;
    if (typeof rawSystemPrompt === 'string') {
      messages.push({ role: 'system', content: rawSystemPrompt });
    }

    // Structured output: append schema as instruction to user message
    const outputFormat = requestOptions?.outputFormat;
    const userContent = outputFormat
      ? `${prompt}\n\n---\n\nCRITICAL: Respond with ONLY a JSON object matching the schema below. No prose, no markdown fences.\n\nSchema:\n${JSON.stringify(outputFormat.schema, null, 2)}`
      : prompt;

    messages.push({ role: 'user', content: userContent });

    const body = JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.3,
    });

    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': HTTP_REFERER,
        'X-Title': 'Archon',
      },
      body,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '(no body)');
      throw new Error(`OpenRouter ${response.status}: ${errText.slice(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('OpenRouter returned no response body');
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              accumulated += content;
              yield { type: 'assistant', content };
            }
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens ?? 0;
              outputTokens = parsed.usage.completion_tokens ?? 0;
            }
          } catch {
            // Ignore malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Parse structured output from accumulated text
    let structuredOutput: unknown;
    if (outputFormat && accumulated) {
      try {
        structuredOutput = JSON.parse(stripCodeFences(accumulated));
      } catch {
        // Degrade gracefully — dag-executor's structured_output_missing path handles it
      }
    }

    yield {
      type: 'result',
      sessionId: `kimi-${Date.now()}`,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
      },
      structuredOutput,
    };
  }

  getType(): string {
    return 'kimi';
  }

  getCapabilities(): ProviderCapabilities {
    return KIMI_CAPABILITIES;
  }
}
