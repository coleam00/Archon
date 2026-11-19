import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { nativeToolInputParser } from '@archon/provider-contract';
import type { NativeTool } from '../types';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** The in-process MCP server name; tools are callable as `mcp__archon__<name>`. */
export const ARCHON_TOOL_SERVER = 'archon';

const nativeCallSchema = z.object({
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string(),
    arguments: z.unknown().optional(),
    task: z.never().optional(),
  }),
});

export function buildArchonMcpServer(nativeTools: NativeTool[]): McpSdkServerConfigWithInstance {
  const server = createSdkMcpServer({ name: ARCHON_TOOL_SERVER, version: '1.0.0', tools: [] });
  const providerCallScope = randomUUID();
  const tools = new Map(
    nativeTools.map(spec => [spec.name, { spec, parse: nativeToolInputParser(spec.inputSchema) }])
  );
  if (tools.size !== nativeTools.length) throw new Error('Duplicate native tool name');
  for (const { spec, parse } of tools.values()) {
    // The SDK types use an older Zod minor; MCP accepts this Zod 4 schema at runtime.
    type SdkInput = Extract<
      NonNullable<ReturnType<typeof server.instance.registerTool>['inputSchema']>,
      { _zod: unknown }
    >;
    server.instance.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: ('jsonSchema' in spec.inputSchema
          ? z.looseObject({}).meta(spec.inputSchema.jsonSchema)
          : parse) as unknown as SdkInput,
        _meta: { 'anthropic/alwaysLoad': true },
      },
      async (args: unknown, extra: { requestId: string | number }) =>
        toolResult(
          await spec.handler(parse.parse(args), {
            providerCallId: String(extra.requestId),
            providerCallScope,
          })
        )
    );
  }
  if (nativeTools.some(spec => 'jsonSchema' in spec.inputSchema)) {
    server.instance.server.setRequestHandler(
      nativeCallSchema as unknown as Parameters<typeof server.instance.server.setRequestHandler>[0],
      async (request, { requestId }) => {
        const { params } = nativeCallSchema.parse(request);
        const tool = tools.get(params.name);
        if (!tool) return { ...toolResult('Unknown native tool'), isError: true };
        const args = tool.parse.safeParse(params.arguments);
        if (!args.success)
          return { ...toolResult(`Invalid tool arguments: ${args.error.message}`), isError: true };
        try {
          return toolResult(
            await tool.spec.handler(args.data, {
              providerCallId: String(requestId),
              providerCallScope,
            })
          );
        } catch (error) {
          return {
            ...toolResult(error instanceof Error ? error.message : String(error)),
            isError: true,
          };
        }
      }
    );
  }
  return server;
}

function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
