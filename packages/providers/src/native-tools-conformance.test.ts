import { describe, expect, test } from 'bun:test';
import Ajv from 'ajv';
import { z } from 'zod';
import { buildArchonMcpServer, nativeToolInputToZodShape } from './claude/native-tools';
import {
  buildPiNativeToolDefinitions,
  nativeToolInputToTypeBox,
} from './community/pi/native-tools';
import { defineNativeToolInputSchema, type NativeTool, type NativeToolInputSchema } from './types';

const SCHEMA: NativeToolInputSchema = defineNativeToolInputSchema({
  properties: {
    action: { kind: 'enum', values: ['list', 'get'], description: 'the action' },
    runId: { kind: 'string' },
    confirm: { kind: 'boolean', description: 'guard' },
  },
  required: ['action'],
});

/**
 * Value-level cases both converters' emitted schemas must agree on: enum
 * membership, required vs optional, primitive kind, and top-level object-ness.
 * Unsupported field kinds are no longer representable, so they are a compile
 * error rather than a runtime rejection case.
 */
const CASES: { label: string; input: unknown; accept: boolean }[] = [
  { label: 'minimal valid input', input: { action: 'list' }, accept: true },
  {
    label: 'every declared field',
    input: { action: 'get', runId: 'abc12345', confirm: true },
    accept: true,
  },
  { label: 'value outside the enum', input: { action: 'delete' }, accept: false },
  { label: 'required key missing', input: { runId: 'abc12345' }, accept: false },
  {
    label: 'wrong primitive for a boolean',
    input: { action: 'list', confirm: 'yes' },
    accept: false,
  },
  { label: 'array instead of object', input: [], accept: false },
];

describe('native tool input schema conformance', () => {
  test('Claude (Zod) and Pi (TypeBox) accept and reject the same inputs', () => {
    const zodObject = z.object(nativeToolInputToZodShape(SCHEMA));
    const validatePi = new Ajv({ strict: false }).compile(nativeToolInputToTypeBox(SCHEMA));
    for (const { label, input, accept } of CASES) {
      expect({
        label,
        claude: zodObject.safeParse(input).success,
        pi: validatePi(input) === true,
      }).toEqual({ label, claude: accept, pi: accept });
    }
  });

  test('Pi still emits a JSON-Schema string enum for enum properties (Vertex compatibility)', () => {
    const schema = nativeToolInputToTypeBox(SCHEMA) as unknown as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.action).toMatchObject({ type: 'string', enum: ['list', 'get'] });
    expect(schema.properties.confirm).toMatchObject({ type: 'boolean', description: 'guard' });
  });

  test('both builders accept a NativeTool carrying the typed schema', () => {
    const tool: NativeTool = {
      name: 'manage_run',
      description: 'conformance fixture',
      inputSchema: SCHEMA,
      handler: () => Promise.resolve('ok'),
    };
    expect(buildArchonMcpServer([tool])).toBeDefined();
    expect(buildPiNativeToolDefinitions([tool])).toHaveLength(1);
  });
});
