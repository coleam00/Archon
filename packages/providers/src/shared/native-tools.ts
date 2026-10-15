import { z, type ZodTypeAny } from 'zod';
import type { NativeToolInputSchema, NativeToolProperty } from '../types';

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
 * Shared input validation for Claude's SDK tools and Codex's dynamic tools. Deliberately flat: a property is a string, a string enum,
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
