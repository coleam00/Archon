import { describe, expect, test } from 'bun:test';
import { buildCodexNativeTools } from './codex/native-tools';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import { z } from 'zod';
import { buildArchonMcpServer } from './claude/native-tools';
import { nativeToolInputToZodShape } from './shared/native-tools';
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
 * Value-level cases the converters' emitted schemas must agree on: enum
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
  test('Claude, Pi and Codex accept and reject the same inputs', async () => {
    const zodObject = z.object(nativeToolInputToZodShape(SCHEMA));
    const validatePi = new Ajv({ strict: false }).compile(nativeToolInputToTypeBox(SCHEMA));
    const codex = buildCodexNativeTools([
      {
        name: 'manage_run',
        description: 'fixture',
        inputSchema: SCHEMA,
        handler: () => Promise.resolve('ok'),
      },
    ]);
    const spec = codex.specs[0];
    if (
      spec.type !== 'function' ||
      typeof spec.inputSchema !== 'object' ||
      spec.inputSchema === null
    )
      throw new Error('Expected a function input schema');
    const validateCodex = new Ajv2020({ strict: false }).compile(spec.inputSchema);
    for (const { label, input, accept } of CASES) {
      const response = await codex.call(
        {
          threadId: 't',
          turnId: 'u',
          callId: 'c',
          namespace: null,
          tool: 'manage_run',
          arguments: input,
        },
        't',
        'u'
      );
      expect({
        label,
        claude: zodObject.safeParse(input).success,
        pi: validatePi(input) === true,
        codexSchema: validateCodex(input) === true,
        codexHandler: response.success,
      }).toEqual({ label, claude: accept, pi: accept, codexSchema: accept, codexHandler: accept });
    }
  });

  test('Pi still emits a JSON-Schema string enum for enum properties (Vertex compatibility)', () => {
    const schema = nativeToolInputToTypeBox(SCHEMA) as unknown as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.action).toMatchObject({ type: 'string', enum: ['list', 'get'] });
    expect(schema.properties.confirm).toMatchObject({ type: 'boolean', description: 'guard' });
  });

  test('Claude still emits per-property descriptions into the JSON Schema', () => {
    // Descriptions are invisible to `safeParse`, so only the emitted schema can
    // catch a dropped `.describe()`. `.optional()` sits between the getter and
    // the caller, so read the description through `z.toJSONSchema`.
    const schema = z.toJSONSchema(z.object(nativeToolInputToZodShape(SCHEMA))) as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.action).toMatchObject({
      enum: ['list', 'get'],
      description: 'the action',
    });
    expect(schema.properties.confirm).toMatchObject({
      type: 'boolean',
      description: 'guard',
    });
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
