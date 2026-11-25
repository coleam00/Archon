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
 * The template of the smallest request `schema` admits: only required properties and the
 * first alternative. Every value the caller supplies is a bare token outside JSON quotes,
 * `<name>`, or `<name: type>` and `<name: a|b>` when it is not a free string, so a
 * template with any value left unfilled is not JSON and the CLI refuses it before
 * dispatch. Only a `const`, which the caller cannot choose, prints as JSON. Throws on a
 * schema shape it cannot build from rather than printing a wrong template.
 */
export function exampleTemplate(schema: unknown, name = 'value'): string {
  if (!isSchema(schema)) throw new Error(`request schema at '${name}' is not an object`);
  if ('const' in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return `<${name}: ${schema.enum.join('|')}>`;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return exampleTemplate(alternatives[0], name);
  switch (schema.type) {
    case 'object': {
      const properties = isSchema(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      const fields = required.map(
        property => `${JSON.stringify(property)}:${exampleTemplate(properties[property], property)}`
      );
      return `{${fields.join(',')}}`;
    }
    case 'array':
      return `[${exampleTemplate(schema.items, name)}]`;
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

/** Every described property as `dotted.path: description`, from all alternatives, once each. */
function fieldNotes(schema: unknown, path: string, notes: Map<string, string>): void {
  if (!isSchema(schema)) return;
  if (path && typeof schema.description === 'string') notes.set(path, schema.description);
  for (const alternative of [schema.anyOf, schema.oneOf].flat())
    if (alternative !== undefined) fieldNotes(alternative, path, notes);
  if (isSchema(schema.properties))
    for (const [property, child] of Object.entries(schema.properties))
      fieldNotes(child, path ? `${path}.${property}` : property, notes);
  if (schema.items !== undefined) fieldNotes(schema.items, path, notes);
}

/** The request type, its field notes and a template `--data` value for one operation. */
export function forgeRequestHelp(op: string, schema: unknown): HelpRequest {
  const notes = new Map<string, string>();
  fieldNotes(schema, '', notes);
  return {
    type: convertOutputSchema(schema).type,
    notes: [...notes].map(([path, description]) => `${path}: ${description}`),
    example: `archon forge ${op} --data '${exampleTemplate(schema)}'`,
  };
}
