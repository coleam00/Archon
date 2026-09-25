// Direct `zod` import (not `@hono/zod-openapi`): this builds the Zod shape the
// Claude SDK's `tool()` expects, never an OpenAPI schema, and `@archon/providers`
// is an SDK-deps-only leaf package that must not pull in Hono. See the documented
// exception in CLAUDE.md (Zod Schema Conventions).
import { z, type ZodTypeAny } from 'zod';
import {
  tool,
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import type { NativeTool, NativeToolInputSchema, NativeToolProperty } from '../types';

/** The in-process MCP server name; tools are callable as `mcp__archon__<name>`. */
export const ARCHON_TOOL_SERVER = 'archon';

type ZodRawShape = Record<string, ZodTypeAny>;

function zodFieldForProperty(prop: NativeToolProperty): ZodTypeAny {
  switch (prop.kind) {
    case 'string':
      return z.string();
    case 'enum':
      return z.enum([...prop.values]);
    case 'boolean':
      return z.boolean();
    default: {
      const unreachable: never = prop;
      throw new Error(`native tool schema: unhandled field kind ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Map a native tool's typed input shape to the Zod raw shape the Claude SDK's
 * `tool()` expects. Deliberately flat: a property is a string, a string enum,
 * or a boolean, and `required` decides whether it is optional.
 */
export function nativeToolInputToZodShape(input: NativeToolInputSchema): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const [key, prop] of Object.entries(input.properties)) {
    let field = zodFieldForProperty(prop);
    if (prop.description !== undefined) field = field.describe(prop.description);
    shape[key] = input.required.includes(key) ? field : field.optional();
  }
  return shape;
}

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
