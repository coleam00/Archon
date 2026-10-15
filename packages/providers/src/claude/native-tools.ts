import {
  tool,
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import type { NativeTool } from '../types';
import { nativeToolInputToZodShape } from '../shared/native-tools';

/** The in-process MCP server name; tools are callable as `mcp__archon__<name>`. */
export const ARCHON_TOOL_SERVER = 'archon';

/**
 * Build a single in-process SDK MCP server exposing the given NativeTools.
 * `alwaysLoad` keeps the tools visible without tool-search (which Haiku lacks).
 * Each tool's handler maps its text result into a CallToolResult.
 */
export function buildArchonMcpServer(nativeTools: NativeTool[]): McpSdkServerConfigWithInstance {
  const tools = nativeTools.map(spec =>
    tool(
      spec.name,
      spec.description,
      nativeToolInputToZodShape(spec.inputSchema),
      async (args): Promise<{ content: { type: 'text'; text: string }[] }> => ({
        content: [{ type: 'text', text: await spec.handler(args as Record<string, unknown>) }],
      })
    )
  );
  return createSdkMcpServer({
    name: ARCHON_TOOL_SERVER,
    version: '1.0.0',
    tools,
    alwaysLoad: true,
  });
}
