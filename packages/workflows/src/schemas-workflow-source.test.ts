import { describe, expect, test } from 'bun:test';
import { WORKFLOW_SOURCES } from '@archon/paths/workflow-source';
import { workflowSourceSchema } from './schemas/workflow';

describe('workflow source schema', () => {
  test('accepts exactly the shared source vocabulary in its original order', () => {
    expect(workflowSourceSchema.options).toEqual([...WORKFLOW_SOURCES]);
    for (const source of WORKFLOW_SOURCES) {
      expect(workflowSourceSchema.parse(source)).toBe(source);
    }
  });

  test('rejects unsupported and missing sources', () => {
    expect(workflowSourceSchema.safeParse('unsupported').success).toBe(false);
    expect(workflowSourceSchema.safeParse(undefined).success).toBe(false);
  });
});
