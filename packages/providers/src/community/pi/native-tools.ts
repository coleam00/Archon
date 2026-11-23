import { nativeToolInputParser, nativeToolInputSchema } from '@archon/provider-contract';
import { Type, StringEnum, type TSchema } from '@earendil-works/pi-ai';
import {
  createCodingTools,
  createReadOnlyTools,
  createPowerShellToolDefinition,
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { NativeTool, NativeToolInputSchema, NativeToolProperty } from '../../types';
import { ClassifiedProviderError } from '../../shared/failure';

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
 * Map a native tool's input schema to Pi's TypeBox definition. Keep the authored
 * JSON Schema intact; legacy declarations use flat string, enum and boolean fields.
 */
export function nativeToolInputToTypeBox(input: NativeToolInputSchema): TSchema {
  nativeToolInputSchema.parse(input);
  if ('jsonSchema' in input) return Type.Unsafe(input.jsonSchema);
  const shape: Record<string, TSchema> = {};
  for (const [key, prop] of Object.entries(input.properties)) {
    let field = typeBoxFieldForProperty(prop);
    if (prop.description !== undefined) {
      field = Type.Unsafe<unknown>({ ...field, description: prop.description });
    }
    shape[key] = input.required.includes(key) ? field : Type.Optional(field);
  }
  return Type.Object(shape, { additionalProperties: false });
}

/**
 * Adapt NativeTools to Pi `ToolDefinition`s for the `customTools` array. The
 * handler's text result becomes the tool's content; `details` is unused.
 */
export function buildPiNativeToolDefinitions(
  nativeTools: NativeTool[],
  internalTools: Pick<ToolDefinition, 'name'>[] = []
): ToolDefinition[] {
  const reservedNames = new Set(
    [
      ...createCodingTools(process.cwd()),
      ...createReadOnlyTools(process.cwd()),
      createPowerShellToolDefinition(process.cwd()),
      ...internalTools,
    ].map(tool => tool.name)
  );
  for (const spec of nativeTools) {
    if (reservedNames.has(spec.name)) {
      throw new ClassifiedProviderError(
        'misconfigured',
        `Native tool '${spec.name}' conflicts with a Pi built-in or internal tool. Rename the declared tool.`
      );
    }
  }
  return nativeTools.map(spec => {
    const parser = nativeToolInputParser(spec.inputSchema);
    return defineTool({
      // Pi shows `label` in its UI; derive it per-tool from the name so a future
      // second native tool doesn't inherit a hardcoded "Manage runs".
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: nativeToolInputToTypeBox(spec.inputSchema),
      ...('jsonSchema' in spec.inputSchema
        ? { prepareArguments: (input: unknown) => parser.parse(input) }
        : {}),
      execute: async (_toolCallId, params) => {
        const parsed = parser.parse(params);
        return {
          content: [
            {
              type: 'text' as const,
              text: await spec.handler(parsed, { providerCallId: _toolCallId }),
            },
          ],
          details: undefined,
        };
      },
    });
  });
}
