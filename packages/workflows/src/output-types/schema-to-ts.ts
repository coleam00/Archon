/**
 * JSON Schema to TypeScript, for the subset of `output_format` a type can state.
 *
 * The engine validates a node's output with ajv, which accepts all of JSON Schema.
 * A type cannot state all of it, so this converter takes the keywords that decide a
 * value's shape, ignores the ones that only narrow a value within its shape, and
 * refuses every other keyword by name. It never widens a schema it cannot read.
 */

/** A value an `enum` or `const` can hold and a TypeScript literal type can state. */
export type SchemaLiteral = string | number | boolean | null;

export interface ConvertedSchema {
  /** The TypeScript type, multi-line, indented from column zero. */
  readonly type: string;
  /** Every `enum` in the schema, keyed by its path, in schema order. */
  readonly enums: ReadonlyMap<string, readonly SchemaLiteral[]>;
}

/** A schema this converter cannot state as a type: which keyword, and where. */
export class UnsupportedSchemaError extends Error {
  constructor(
    readonly keyword: string,
    readonly schemaPath: string,
    readonly detail: string
  ) {
    super(`keyword '${keyword}' at '${schemaPath}': ${detail}`);
    this.name = 'UnsupportedSchemaError';
  }
}

/** The path of the schema's root in errors and in the enum map. */
export const SCHEMA_ROOT = '$';

/** Keywords that decide the shape of a value. */
const SHAPE_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
]);

/**
 * Keywords that narrow a value without changing its TypeScript shape (a pattern, a
 * bound), or that describe it. ajv still enforces them at the node boundary.
 */
const SHAPELESS_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

const OBJECT_KEYWORDS = ['properties', 'required', 'additionalProperties'] as const;
const TYPED_KEYWORDS = [...OBJECT_KEYWORDS, 'items', 'type'] as const;

type SchemaObject = Readonly<Record<string, unknown>>;
type Enums = Map<string, readonly SchemaLiteral[]>;

function isRecord(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(path: string, segment: string): string {
  if (path === SCHEMA_ROOT) return segment.startsWith('[') ? `${SCHEMA_ROOT}${segment}` : segment;
  return segment.startsWith('[') ? `${path}${segment}` : `${path}.${segment}`;
}

/** A single-quoted TypeScript string literal. */
export function quote(value: string): string {
  const body = JSON.stringify(value).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'");
  return `'${body}'`;
}

/** A property name as TypeScript writes it: bare when it is an identifier, quoted otherwise. */
export function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

export function literal(value: SchemaLiteral): string {
  return typeof value === 'string' ? quote(value) : String(value);
}

export function indent(text: string): string {
  return text
    .split('\n')
    .map(line => (line === '' ? line : `  ${line}`))
    .join('\n');
}

function union(members: readonly string[]): string {
  const unique = [...new Set(members)];
  return unique.length === 0 ? 'never' : unique.join(' | ');
}

function literals(keyword: string, path: string, values: readonly unknown[]): SchemaLiteral[] {
  return values.map(value => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      return value as SchemaLiteral;
    }
    throw new UnsupportedSchemaError(
      keyword,
      path,
      'only string, number, boolean and null values can be stated as a type'
    );
  });
}

function convertAlternatives(
  keyword: 'anyOf' | 'oneOf',
  schema: SchemaObject,
  path: string,
  enums: Enums
): string {
  const branches = schema[keyword];
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new UnsupportedSchemaError(keyword, path, 'must be a non-empty list of schemas');
  }
  // A sibling shape keyword intersects with every branch. No type states that without
  // guessing, so the schema has to move the shared part into each branch.
  const sibling = [...SHAPE_KEYWORDS].find(key => key !== keyword && Object.hasOwn(schema, key));
  if (sibling !== undefined) {
    throw new UnsupportedSchemaError(
      sibling,
      path,
      `cannot be combined with '${keyword}' in one schema; move it into each alternative`
    );
  }
  return union(
    branches.map((branch, index) =>
      convert(branch, childPath(path, `${keyword}[${String(index)}]`), enums)
    )
  );
}

/** An object schema without `properties`: a map of whatever additionalProperties admits. */
function convertRecord(schema: SchemaObject, path: string, enums: Enums): string {
  const { required, additionalProperties } = schema;
  if (Array.isArray(required) && required.length > 0) {
    throw new UnsupportedSchemaError(
      'required',
      path,
      'names properties the schema does not declare under properties'
    );
  }
  if (additionalProperties === false) return 'Readonly<Record<string, never>>';
  const value =
    additionalProperties === undefined || additionalProperties === true
      ? 'unknown'
      : convert(additionalProperties, childPath(path, '*'), enums);
  return `Readonly<Record<string, ${value}>>`;
}

function convertObject(schema: SchemaObject, path: string, enums: Enums): string {
  const { properties, required, additionalProperties } = schema;
  if (required !== undefined && !Array.isArray(required)) {
    throw new UnsupportedSchemaError('required', path, 'must be a list of property names');
  }
  if (properties === undefined) return convertRecord(schema, path, enums);
  if (!isRecord(properties)) {
    throw new UnsupportedSchemaError('properties', path, 'must be a map of schemas');
  }
  if (additionalProperties !== undefined && typeof additionalProperties !== 'boolean') {
    throw new UnsupportedSchemaError(
      'additionalProperties',
      path,
      'a schema here cannot be combined with properties; only true or false can'
    );
  }
  const requiredNames = new Set<unknown>(required ?? []);
  const undeclared = [...requiredNames].find(
    name => typeof name !== 'string' || !Object.hasOwn(properties, name)
  );
  if (undeclared !== undefined) {
    throw new UnsupportedSchemaError(
      'required',
      path,
      `names '${String(undeclared)}', which properties does not declare`
    );
  }
  const names = Object.keys(properties);
  if (names.length === 0) return 'Readonly<Record<string, unknown>>';
  const members = names.map(name => {
    const optional = requiredNames.has(name) ? '' : '?';
    const type = convert(properties[name], childPath(path, name), enums);
    return `readonly ${propertyKey(name)}${optional}: ${type};`;
  });
  return `{\n${indent(members.join('\n'))}\n}`;
}

function convertArray(schema: SchemaObject, path: string, enums: Enums): string {
  const { items } = schema;
  if (Array.isArray(items)) {
    throw new UnsupportedSchemaError('items', path, 'the tuple form is not supported');
  }
  const item = items === undefined ? 'unknown' : convert(items, childPath(path, '[]'), enums);
  return `ReadonlyArray<${item}>`;
}

function convertTyped(schema: SchemaObject, path: string, enums: Enums): string {
  const { type } = schema;
  if (type === undefined) {
    const shaped = TYPED_KEYWORDS.find(key => Object.hasOwn(schema, key));
    if (shaped === undefined) return 'unknown';
    throw new UnsupportedSchemaError(
      shaped,
      path,
      "needs a 'type' beside it; without one the schema also admits values of every other type"
    );
  }
  const types: readonly unknown[] = Array.isArray(type) ? type : [type];
  if (types.length === 0) throw new UnsupportedSchemaError('type', path, 'must name a type');
  const stray = [
    ...(types.includes('object') ? [] : OBJECT_KEYWORDS),
    ...(types.includes('array') ? [] : (['items'] as const)),
  ].find(key => Object.hasOwn(schema, key));
  if (stray !== undefined) {
    throw new UnsupportedSchemaError(
      stray,
      path,
      `applies to no type this schema declares (${types.map(String).join(', ')})`
    );
  }
  return union(
    types.map(name => {
      switch (name) {
        case 'string':
        case 'boolean':
        case 'null':
          return name;
        case 'number':
        case 'integer':
          return 'number';
        case 'object':
          return convertObject(schema, path, enums);
        case 'array':
          return convertArray(schema, path, enums);
        default:
          throw new UnsupportedSchemaError('type', path, `'${String(name)}' is not a JSON type`);
      }
    })
  );
}

function convert(schema: unknown, path: string, enums: Enums): string {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (!isRecord(schema)) {
    throw new UnsupportedSchemaError('schema', path, 'must be an object or a boolean');
  }
  const unsupported = Object.keys(schema).find(
    key => !SHAPE_KEYWORDS.has(key) && !SHAPELESS_KEYWORDS.has(key)
  );
  if (unsupported !== undefined) {
    throw new UnsupportedSchemaError(unsupported, path, 'is not supported');
  }
  if (Object.hasOwn(schema, 'anyOf') && Object.hasOwn(schema, 'oneOf')) {
    throw new UnsupportedSchemaError('oneOf', path, "cannot be combined with 'anyOf'");
  }
  if (Object.hasOwn(schema, 'anyOf')) return convertAlternatives('anyOf', schema, path, enums);
  if (Object.hasOwn(schema, 'oneOf')) return convertAlternatives('oneOf', schema, path, enums);
  // `const` and `enum` list the admitted values outright, so they are the type. A `type`
  // beside them can only restate or remove values, and ajv enforces that.
  if (Object.hasOwn(schema, 'const')) {
    return union(literals('const', path, [schema.const]).map(literal));
  }
  if (Object.hasOwn(schema, 'enum')) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new UnsupportedSchemaError('enum', path, 'must be a non-empty list of values');
    }
    const values = literals('enum', path, schema.enum);
    // Two property names can spell one path (`a.b` under the root, `b` under `a`).
    if (enums.has(path)) {
      throw new UnsupportedSchemaError('enum', path, 'is the path of two enums in this schema');
    }
    enums.set(path, values);
    return union(values.map(literal));
  }
  return convertTyped(schema, path, enums);
}

/**
 * The TypeScript type of the values `schema` admits, and its enums. Throws
 * {@link UnsupportedSchemaError} for a schema no type states exactly enough.
 */
export function convertOutputSchema(schema: unknown): ConvertedSchema {
  const enums: Enums = new Map();
  return { type: convert(schema, SCHEMA_ROOT, enums), enums };
}
