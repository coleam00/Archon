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
import type { NativeTool } from '../types';

/** The in-process MCP server name; tools are callable as `mcp__archon__<name>`. */
export const ARCHON_TOOL_SERVER = 'archon';

type ZodRawShape = Record<string, ZodTypeAny>;

/**
 * Convert a NativeTool's canonical JSON Schema into the Zod raw shape the Claude
 * SDK's `tool()` expects. Deliberately narrow — only the subset our tools use
 * (a flat object of strings / string-enums / booleans, with `required`).
 * Anything else throws (fail-fast) rather than silently mis-converting.
 */
function jsonSchemaToZodShape(schema: Record<string, unknown>): ZodRawShape {
  if (
    schema.type !== 'object' ||
    typeof schema.properties !== 'object' ||
    schema.properties === null
  ) {
    throw new Error('native tool inputSchema must be an object schema with `properties`');
  }
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as unknown[]).filter(isString) : []
  );

  const shape: ZodRawShape = {};
  for (const [key, prop] of Object.entries(props)) {
    let field: ZodTypeAny;
    if (Array.isArray(prop.enum)) {
      const values = prop.enum.filter(isString);
      if (values.length === 0) {
        throw new Error(`native tool schema: enum for '${key}' must be non-empty strings`);
      }
      field = z.enum(values as [string, ...string[]]);
    } else if (prop.type === 'string') {
      field = z.string();
    } else if (prop.type === 'boolean') {
      field = z.boolean();
    } else {
      throw new Error(
        `native tool schema: unsupported type for '${key}' (only string / string-enum / boolean)`
      );
    }
    if (typeof prop.description === 'string') field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
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
      jsonSchemaToZodShape(spec.inputSchema),
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
