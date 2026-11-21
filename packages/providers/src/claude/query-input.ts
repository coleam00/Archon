import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The query's streaming input: the prompt, then each engine `turnMessages` text until the
 * input closes. An engine text goes at priority 'next', which the CLI reads at the agent's
 * next step; 'now' would interrupt the running tool call, which the engine never asks for.
 * `client_composed` keeps the CLI from expanding `@path` mentions or running slash
 * commands from text the user did not type.
 */
export function createQueryInput(
  prompt: string,
  resumeSessionId: string | undefined,
  signal: AbortSignal,
  turnMessages?: AsyncIterable<string>
): {
  messages: AsyncGenerator<SDKUserMessage>;
  admit: () => void;
  close: () => void;
} {
  const admission = Promise.withResolvers<boolean>();
  const closed = Promise.withResolvers<void>();
  const sessionId = resumeSessionId ?? '';
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    if (!(await admission.promise) || signal.aborted) return;
    yield {
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    if (turnMessages) {
      const texts = turnMessages[Symbol.asyncIterator]();
      const closing = closed.promise.then(() => undefined);
      while (true) {
        const next = await Promise.race([texts.next(), closing]);
        if (next === undefined || next.done === true) break;
        yield {
          type: 'user',
          message: { role: 'user', content: next.value },
          parent_tool_use_id: null,
          session_id: sessionId,
          priority: 'next',
          client_composed: true,
        };
      }
    }
    await closed.promise;
  }
  return {
    messages: messages(),
    admit: () => admission.resolve(true),
    close: () => {
      admission.resolve(false);
      closed.resolve();
    },
  };
}
