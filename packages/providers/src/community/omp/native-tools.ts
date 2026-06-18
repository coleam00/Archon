import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import type { NativeTool } from '../../types';
import type { OmpCustomTool, OmpCustomToolResult } from './sdk-loader';

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Convert Archon's canonical JSON Schema into the TypeBox-compatible schema OMP
 * accepts for inline CustomTool parameters. Keep the supported subset narrow so
 * unsupported provider-neutral tools fail before a session is created instead of
 * registering a tool the SDK cannot validate predictably.
 */
function jsonSchemaToTypeBox(schema: Record<string, unknown>): TObject {
  if (
    schema.type !== 'object' ||
    typeof schema.properties !== 'object' ||
    schema.properties === null
  ) {
    throw new Error('native tool inputSchema must be an object schema with `properties`');
  }

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as unknown[]).filter(isString) : []
  );
  const shape: Record<string, TSchema> = {};

  for (const [key, property] of Object.entries(properties)) {
    let field: TSchema;
    if (Array.isArray(property.enum)) {
      const values = property.enum.filter(isString);
      if (values.length === 0) {
        throw new Error(`native tool schema: enum for '${key}' must be non-empty strings`);
      }
      field = Type.Union(values.map(value => Type.Literal(value)));
    } else if (property.type === 'string') {
      field = Type.String();
    } else if (property.type === 'boolean') {
      field = Type.Boolean();
    } else {
      throw new Error(
        `native tool schema: unsupported type for '${key}' (only string / string-enum / boolean)`
      );
    }

    if (typeof property.description === 'string') {
      field = Type.Unsafe<unknown>({ ...field, description: property.description });
    }
    shape[key] = required.has(key) ? field : Type.Optional(field);
  }

  return Type.Object(shape);
}

/** Adapt Archon NativeTools to OMP SDK CustomTool objects. */
export function buildOmpNativeToolDefinitions(nativeTools: NativeTool[]): OmpCustomTool[] {
  return nativeTools.map(tool => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: jsonSchemaToTypeBox(tool.inputSchema),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>
    ): Promise<OmpCustomToolResult> {
      return {
        content: [{ type: 'text', text: await tool.handler(params) }],
        details: undefined,
      };
    },
  }));
}
