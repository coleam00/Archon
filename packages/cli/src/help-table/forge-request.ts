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
 * The shape of the smallest request `schema` admits: only required properties and the
 * first alternative. Every value the caller supplies is a `"<name>"` placeholder, with
 * its type or choices when it is not a string (`"<number: integer>"`,
 * `"<method: merge|squash>"`), so no example value can be copied as a real one. Only a
 * `const`, which the caller cannot choose, is printed as itself. Throws on a schema shape
 * it cannot build from rather than printing a wrong example.
 */
export function exampleRequest(schema: unknown, name = 'value'): unknown {
  if (!isSchema(schema)) throw new Error(`request schema at '${name}' is not an object`);
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return `<${name}: ${schema.enum.join('|')}>`;
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
      return [exampleRequest(schema.items, name)];
    case 'string':
      return `<${name}>`;
    case 'integer':
    case 'number':
    case 'boolean':
    case 'null':
      return `<${name}: ${schema.type}>`;
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
