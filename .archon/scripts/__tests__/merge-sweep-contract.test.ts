import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

type Shape = string | { union: Shape[] } | { array: Shape } | {
  fields: Record<string, { required: boolean; shape: Shape }>;
};

interface Schema {
  type: string | string[];
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: false;
}

function union(shapes: Shape[]): Shape {
  const members = new Map(shapes.map(shape => [JSON.stringify(shape), shape]));
  if (members.has('"literal:true"') && members.has('"literal:false"')) {
    members.delete('"literal:true"');
    members.delete('"literal:false"');
    members.set('"boolean"', 'boolean');
  }
  const sorted = [...members].sort(([a], [b]) => a.localeCompare(b)).map(([, shape]) => shape);
  const [only] = sorted;
  return sorted.length === 1 && only !== undefined ? only : { union: sorted };
}

function schemaShape(schema: Schema): Shape {
  // These annotations constrain values without changing their TypeScript shape.
  const supported = ['type', 'enum', 'properties', 'required', 'items', 'additionalProperties',
    'minimum', 'pattern', 'minItems', 'description'];
  expect(Object.keys(schema).filter(key => !supported.includes(key))).toEqual([]);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.enum !== undefined) {
    expect(types).toContain('string');
    expect(schema.enum.every(value => typeof value === 'string')).toBe(true);
    return union(schema.enum.map(value => `literal:${JSON.stringify(value)}`));
  }
  return union(types.map(type => {
    if (type === 'integer') return 'number';
    if (['string', 'number', 'boolean', 'null'].includes(type)) return type;
    if (type === 'array' && schema.items !== undefined) return { array: schemaShape(schema.items) };
    if (type === 'object' && schema.properties !== undefined) {
      if (schema.additionalProperties !== undefined) expect(schema.additionalProperties).toBe(false);
      const properties = schema.properties;
      expect((schema.required ?? []).filter(key => !Object.hasOwn(properties, key))).toEqual([]);
      return { fields: Object.fromEntries(Object.entries(schema.properties).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => [name, { required: schema.required?.includes(name) ?? false, shape: schemaShape(child) }])) };
    }
    throw new Error(`Unsupported sweep schema type: ${type}`);
  }));
}

function typeShape(checker: ts.TypeChecker, type: ts.Type): Shape {
  if (type.isStringLiteral()) return `literal:${JSON.stringify(type.value)}`;
  if (type.flags & ts.TypeFlags.BooleanLiteral) return `literal:${checker.typeToString(type)}`;
  if (type.isUnion()) return union(type.types.map(member => typeShape(checker, member)));
  if (type.flags & ts.TypeFlags.String) return 'string';
  if (type.flags & ts.TypeFlags.Number) return 'number';
  if (type.flags & ts.TypeFlags.Null) return 'null';
  if (type.flags & ts.TypeFlags.Undefined) return 'undefined';
  if (checker.isArrayType(type)) {
    const item = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (item !== undefined) return { array: typeShape(checker, item) };
  }
  if (type.flags & ts.TypeFlags.Object) {
    return { fields: Object.fromEntries(checker.getPropertiesOfType(type).sort((a, b) => a.name.localeCompare(b.name))
      .map(property => {
        const declaration = property.valueDeclaration;
        if (declaration === undefined) throw new Error(`No declaration for ${property.name}`);
        const required = !(property.flags & ts.SymbolFlags.Optional);
        const value = checker.getTypeOfSymbolAtLocation(property, declaration);
        const shape = !required && value.isUnion()
          ? union(value.types.filter(member => !(member.flags & ts.TypeFlags.Undefined)).map(member => typeShape(checker, member)))
          : typeShape(checker, value);
        return [property.name, { required, shape }];
      })) };
  }
  throw new Error(`Unsupported sweep consumer type: ${checker.typeToString(type)}`);
}

test('the complete sweep output conforms to the recorder contract', () => {
  const pack = resolve(import.meta.dir, '../../workflows/sdlc');
  const workflow = Bun.YAML.parse(readFileSync(resolve(pack, 'merge-queue/archon-merge-queue.yaml'), 'utf8')) as {
    nodes: { id: string; output_format?: Schema }[];
  };
  const sweeps = workflow.nodes.filter(node => node.id === 'sweep');
  expect(sweeps).toHaveLength(1);
  const schema = sweeps[0]?.output_format;
  if (schema === undefined) throw new Error('Missing sweep.output_format');
  // TypeScript's number cannot express the positive integer PR identifier contract.
  expect(schema.properties?.decisions.items?.properties?.number).toMatchObject({
    type: 'integer', minimum: 1,
  });
  const file = resolve(pack, '.shared/merge.ts');
  const program = ts.createProgram([file], {
    strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const module = source && checker.getSymbolAtLocation(source);
  const sweep = module && checker.getExportsOfModule(module).find(symbol => symbol.name === 'Sweep');
  if (sweep === undefined) throw new Error('Missing exported Sweep consumer type');
  expect(typeShape(checker, checker.getDeclaredTypeOfSymbol(sweep))).toEqual(schemaShape(schema));
});

test.each([...Object.getOwnPropertyNames(Object.prototype), 'missing_field'])(
  'rejects undeclared required property %s, including inside arrays', key => {
    const schema: Schema = {
      type: 'object', properties: { value: { type: 'string' } }, required: [key],
    };
    expect(() => schemaShape(schema)).toThrow();
    expect(() => schemaShape({ type: 'array', items: schema })).toThrow();
  }
);
