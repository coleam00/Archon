import { z } from 'zod';
import {
  nativeToolInputSchema,
  type NativeToolInputSchema,
  type NativeToolProperty,
} from './agent-provider';

function zodFieldForProperty(prop: NativeToolProperty): z.ZodType<string | boolean | undefined> {
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

export function nativeToolInputParser(input: NativeToolInputSchema) {
  nativeToolInputSchema.parse(input);
  const shape: Record<string, z.ZodType<string | boolean | undefined>> = {};
  for (const [key, prop] of Object.entries(input.properties)) {
    let field = zodFieldForProperty(prop);
    if (prop.description !== undefined) field = field.describe(prop.description);
    shape[key] = input.required.includes(key) ? field : field.optional();
  }
  return z.strictObject(shape);
}
