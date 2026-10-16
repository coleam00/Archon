import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { nativeToolInputParser } from '@archon/provider-contract';
import type { NativeTool } from '../types';

/** The in-process MCP server name; tools are callable as `mcp__archon__<name>`. */
export const ARCHON_TOOL_SERVER = 'archon';

export function buildArchonMcpServer(nativeTools: NativeTool[]): McpSdkServerConfigWithInstance {
  const server = createSdkMcpServer({ name: ARCHON_TOOL_SERVER, version: '1.0.0', tools: [] });
  for (const spec of nativeTools) {
    const schema = nativeToolInputParser(spec.inputSchema);
    // The SDK types use an older Zod minor; MCP accepts this Zod 4 schema at runtime.
    type SdkInput = Extract<
      NonNullable<ReturnType<typeof server.instance.registerTool>['inputSchema']>,
      { _zod: unknown }
    >;
    server.instance.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: schema as unknown as SdkInput,
        _meta: { 'anthropic/alwaysLoad': true },
      },
      async (args: unknown) => ({
        content: [{ type: 'text', text: await spec.handler(schema.parse(args)) }],
      })
    );
  }
  return server;
}
