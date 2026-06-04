import { describe, test, expect } from 'bun:test';
import { buildPiNativeToolDefinitions } from './native-tools';
import type { NativeTool } from '../../types';

function spec(inputSchema: Record<string, unknown>): NativeTool {
  return {
    name: 'manage_run',
    description: 'test tool',
    inputSchema,
    handler: () => Promise.resolve('ok'),
  };
}

const VALID_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'get'], description: 'the action' },
    runId: { type: 'string' },
    confirm: { type: 'boolean', description: 'guard' },
  },
  required: ['action'],
};

describe('buildPiNativeToolDefinitions (Pi JSON-Schema → TypeBox)', () => {
  test('builds for a valid schema with string / string-enum / boolean fields', () => {
    const defs = buildPiNativeToolDefinitions([spec(VALID_SCHEMA)]);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('manage_run');
  });

  test('rejects a non-object schema (fail-fast)', () => {
    expect(() => buildPiNativeToolDefinitions([spec({ type: 'string' })])).toThrow(
      /must be an object schema/
    );
  });

  test('rejects an unsupported field type (number)', () => {
    expect(() =>
      buildPiNativeToolDefinitions([
        spec({ type: 'object', properties: { n: { type: 'number' } }, required: [] }),
      ])
    ).toThrow(/unsupported type/);
  });

  test('rejects an empty enum', () => {
    expect(() =>
      buildPiNativeToolDefinitions([
        spec({ type: 'object', properties: { a: { enum: [] } }, required: ['a'] }),
      ])
    ).toThrow(/non-empty strings/);
  });
});
