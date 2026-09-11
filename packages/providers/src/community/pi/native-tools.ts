import { Type, StringEnum, type TSchema } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { NativeTool, NativeToolInputSchema, NativeToolProperty } from '../../types';

type TObject = ReturnType<typeof Type.Object>;

function typeBoxFieldForProperty(prop: NativeToolProperty): TSchema {
  switch (prop.kind) {
    case 'string':
      return Type.String();
    case 'enum':
      // StringEnum keeps Google/Vertex working, which reject anyOf/const enums (#3299).
      return StringEnum([...prop.values]);
    case 'boolean':
      return Type.Boolean();
    default: {
      const unreachable: never = prop;
      throw new Error(`native tool schema: unhandled field kind ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Map a native tool's typed input shape to the TypeBox object Pi's `defineTool`
 * expects. Deliberately flat: a property is a string, a string enum, or a
 * boolean, and `required` decides whether it is optional.
 */
export function nativeToolInputToTypeBox(input: NativeToolInputSchema): TObject {
  const shape: Record<string, TSchema> = {};
  for (const [key, prop] of Object.entries(input.properties)) {
    let field = typeBoxFieldForProperty(prop);
    if (prop.description !== undefined) {
      field = Type.Unsafe<unknown>({ ...field, description: prop.description });
    }
    shape[key] = input.required.includes(key) ? field : Type.Optional(field);
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
      parameters: nativeToolInputToTypeBox(spec.inputSchema),
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
