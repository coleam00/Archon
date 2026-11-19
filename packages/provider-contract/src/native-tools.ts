import { z } from 'zod';
import Ajv from 'ajv';
import { rawJsonObjectSchema } from './json-values';
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

export function nativeToolInputParser(
  input: NativeToolInputSchema
): z.ZodType<Record<string, unknown>> {
  nativeToolInputSchema.parse(input);
  if ('jsonSchema' in input) {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(input.jsonSchema);
    if ('$async' in validate && validate.$async)
      throw new Error('Native tools require a synchronous JSON Schema');
    return rawJsonObjectSchema
      .superRefine((value, context) => {
        if (validate(value)) return;
        for (const issue of validate.errors ?? []) {
          context.addIssue({
            code: 'custom',
            message: `${issue.instancePath || '(root)'}: ${issue.message ?? 'invalid'}`,
          });
        }
      })
      .meta(input.jsonSchema);
  }
  const shape: Record<string, z.ZodType<string | boolean | undefined>> = {};
  for (const [key, prop] of Object.entries(input.properties)) {
    let field = zodFieldForProperty(prop);
    if (prop.description !== undefined) field = field.describe(prop.description);
    shape[key] = input.required.includes(key) ? field : field.optional();
  }
  return z.strictObject(shape);
}

export function nativeToolJsonSchema(input: NativeToolInputSchema): Record<string, unknown> {
  return 'jsonSchema' in input
    ? input.jsonSchema
    : z.toJSONSchema(nativeToolInputParser(input), { io: 'input' });
}
