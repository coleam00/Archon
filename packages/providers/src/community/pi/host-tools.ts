import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AgentToolResult,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { HostTool } from '../../types';

export interface PiHostToolSet {
  definitions: ToolDefinition[];
  bind(session: AgentSession): void;
}

export function createPiHostToolSet(tools: readonly HostTool[]): PiHostToolSet {
  // Pi treats a fulfilled execute() as success. Its post-call hook is the SDK
  // seam for carrying an error result without throwing away content/details.
  const errors = new WeakSet<AgentToolResult<unknown>>();
  const definitions = tools.map(tool =>
    defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // Pi validates canonical JSON Schema itself. Rebuilding its properties
      // would lose nested types, constraints, and backend-compatible enums.
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (toolCallId, input, signal, onUpdate) => {
        const result = await tool.handler(input, {
          toolCallId,
          signal,
          onUpdate: onUpdate
            ? (partial): void => {
                // The SDK requires a details slot even when the host omits metadata.
                onUpdate({ ...partial, details: partial.details });
              }
            : undefined,
        });
        const sdkResult = { content: result.content, details: result.details };
        if (result.isError) errors.add(sdkResult);
        return sdkResult;
      },
    })
  );
  return {
    definitions,
    bind(session): void {
      const previous = session.agent.afterToolCall;
      const afterToolCall: NonNullable<AgentSession['agent']['afterToolCall']> = async (
        event,
        signal
      ) => {
        const hostError = errors.has(event.result);
        const isError = event.isError || hostError;
        const overrides = await previous?.({ ...event, isError }, signal);
        // Native result hooks cannot reinterpret a host denial as successful execution.
        return { ...overrides, isError: hostError || (overrides?.isError ?? event.isError) };
      };
      session.agent.afterToolCall = afterToolCall;
    },
  };
}
