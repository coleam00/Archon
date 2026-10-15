import { z } from 'zod';
import type { NativeTool } from '../types';
import { nativeToolInputParser } from '@archon/provider-contract';
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec';
import type { DynamicToolCallParams } from './protocol/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse';

const callSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  namespace: z.string().nullable(),
  tool: z.string(),
  arguments: z.json(),
}) satisfies z.ZodType<DynamicToolCallParams>;

export function toolResponse(text: string, success: boolean): DynamicToolCallResponse {
  return { contentItems: [{ type: 'inputText', text }], success };
}

export function buildCodexNativeTools(tools: readonly NativeTool[]): {
  specs: DynamicToolSpec[];
  call: (
    params: unknown,
    threadId: string,
    turnId: string | undefined
  ) => Promise<DynamicToolCallResponse>;
} {
  const catalog = tools.map(tool => ({
    tool,
    schema: nativeToolInputParser(tool.inputSchema),
  }));
  return {
    specs: catalog.map(({ tool, schema }) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: z.json().parse(z.toJSONSchema(schema, { io: 'input' })),
    })),
    call: async (params, threadId, turnId) => {
      const parsed = callSchema.safeParse(params);
      if (!parsed.success) return toolResponse('Invalid dynamic tool call parameters.', false);
      const call = parsed.data;
      if (call.threadId !== threadId || call.turnId !== turnId) {
        return toolResponse('Dynamic tool call does not belong to the active turn.', false);
      }
      const entry = call.namespace === null && catalog.find(({ tool }) => tool.name === call.tool);
      if (!entry) return toolResponse(`Unknown Archon tool: ${call.tool}`, false);
      const input = entry.schema.safeParse(call.arguments);
      if (!input.success)
        return toolResponse(`Invalid arguments for ${call.tool}: ${input.error.message}`, false);
      try {
        return toolResponse(await entry.tool.handler(input.data), true);
      } catch (error) {
        return toolResponse(
          `${call.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
          false
        );
      }
    },
  };
}
