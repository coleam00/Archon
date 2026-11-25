/**
 * The request block of `archon forge <operation> --help`, derived from the operation's
 * caller-written JSON Schema so the help cannot drift from what the host parses.
 */
import { convertOutputSchema } from '@archon/workflows/output-types/schema-to-ts';
import type { HelpRequest } from './types';

function isSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The smallest value `schema` admits, built deterministically: only required properties,
 * the first alternative, the first enum value, and a `<name>` placeholder for each string.
 * Throws on a schema shape it cannot build from rather than printing a wrong example.
 */
export function exampleRequest(schema: unknown, name = 'value'): unknown {
  if (!isSchema(schema)) throw new Error(`request schema at '${name}' is not an object`);
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return exampleRequest(alternatives[0], name);
  switch (schema.type) {
    case 'object': {
      const properties = isSchema(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      return Object.fromEntries(
        required.map(property => [property, exampleRequest(properties[property], property)])
      );
    }
    case 'array':
      return typeof schema.minItems === 'number' && schema.minItems > 0
        ? Array.from({ length: schema.minItems }, () => exampleRequest(schema.items, name))
        : [];
    case 'string':
      return `<${name}>`;
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      throw new Error(`request schema at '${name}' has no type an example can be built from`);
  }
}

/** The request type and a minimal example `--data` value for one operation's schema. */
export function forgeRequestHelp(op: string, schema: unknown): HelpRequest {
  return {
    type: convertOutputSchema(schema).type,
    example: `archon forge ${op} --data '${JSON.stringify(exampleRequest(schema))}'`,
  };
}
