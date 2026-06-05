import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { NativeTool } from '../../types';

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * Convert a NativeTool's canonical JSON Schema into the TypeBox schema Pi's
 * `defineTool` expects. Same narrow subset as the Claude converter (flat object
 * of strings / string-enums / booleans with `required`); anything else throws
 * (fail-fast).
 */
function jsonSchemaToTypeBox(schema: Record<string, unknown>): TObject {
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

  const shape: Record<string, TSchema> = {};
  for (const [key, prop] of Object.entries(props)) {
    let field: TSchema;
    if (Array.isArray(prop.enum)) {
      const values = prop.enum.filter(isString);
      if (values.length === 0) {
        throw new Error(`native tool schema: enum for '${key}' must be non-empty strings`);
      }
      field = Type.Union(values.map(v => Type.Literal(v)));
    } else if (prop.type === 'string') {
      field = Type.String();
    } else if (prop.type === 'boolean') {
      field = Type.Boolean();
    } else {
      throw new Error(
        `native tool schema: unsupported type for '${key}' (only string / string-enum / boolean)`
      );
    }
    if (typeof prop.description === 'string') {
      field = Type.Unsafe<unknown>({ ...field, description: prop.description });
    }
    shape[key] = required.has(key) ? field : Type.Optional(field);
  }
  return Type.Object(shape);
}

/**
 * Adapt NativeTools to Pi `ToolDefinition`s for the `customTools` array. The
 * handler's text result becomes the tool's content; `details` is unused.
 */
export function buildPiNativeToolDefinitions(nativeTools: NativeTool[]): ToolDefinition[] {
  return nativeTools.map(spec =>
    defineTool({
      // Pi shows `label` in its UI; derive it per-tool from the name so a future
      // second native tool doesn't inherit a hardcoded "Manage runs".
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: jsonSchemaToTypeBox(spec.inputSchema),
      execute: async (
        _toolCallId,
        params
      ): Promise<{ content: { type: 'text'; text: string }[]; details: undefined }> => ({
        content: [{ type: 'text', text: await spec.handler(params as Record<string, unknown>) }],
        details: undefined,
      }),
    })
  );
}
