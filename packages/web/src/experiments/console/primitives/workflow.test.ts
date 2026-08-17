import { describe, test, expect } from 'bun:test';
import { toWorkflow } from './workflow';

describe('toWorkflow — source normalization', () => {
  test('keeps the three distinct sources apart', () => {
    expect(toWorkflow({ workflow: { name: 'a' }, source: 'project' }).source).toBe('project');
    expect(toWorkflow({ workflow: { name: 'a' }, source: 'global' }).source).toBe('global');
    expect(toWorkflow({ workflow: { name: 'a' }, source: 'bundled' }).source).toBe('bundled');
  });

  test('falls back to bundled for an unrecognized source', () => {
    expect(toWorkflow({ workflow: { name: 'a' }, source: 'something-new' }).source).toBe('bundled');
  });

  test('normalizes a missing description to null', () => {
    expect(toWorkflow({ workflow: { name: 'a' }, source: 'project' }).description).toBeNull();
    expect(
      toWorkflow({ workflow: { name: 'a', description: 'hi' }, source: 'project' }).description
    ).toBe('hi');
  });
});

describe('toWorkflow — parseWarnings (#2213)', () => {
  test('carries the warnings through from the API entry', () => {
    const w = toWorkflow({
      workflow: { name: 'gated' },
      source: 'project',
      parseWarnings: ["Node 'plan': unknown key 'interactive' will be ignored."],
    });
    expect(w.parseWarnings).toEqual(["Node 'plan': unknown key 'interactive' will be ignored."]);
  });

  test('defaults to an empty array when the field is absent', () => {
    // The API omits the key entirely for a clean workflow, so every consumer
    // (the picker reads `.length`) needs an array, never undefined.
    const w = toWorkflow({ workflow: { name: 'clean' }, source: 'project' });
    expect(w.parseWarnings).toEqual([]);
  });
});

describe('toWorkflow — declared inputs (#2554)', () => {
  test('flattens the declared map into an ordered list, preserving declaration order', () => {
    const w = toWorkflow({
      workflow: {
        name: 'review-block',
        inputs: {
          diff: { required: true, description: 'the diff to review' },
          style: { default: 'strict' },
        },
      },
      source: 'project',
    });
    expect(w.inputs).toEqual([
      { name: 'diff', required: true, default: null, description: 'the diff to review' },
      { name: 'style', required: false, default: 'strict', description: null },
    ]);
  });

  test('defaults to an empty array when the workflow declares none', () => {
    // The run card reads `.length` to decide whether to render the form at all.
    expect(toWorkflow({ workflow: { name: 'plain' }, source: 'project' }).inputs).toEqual([]);
  });

  test('treats an absent required flag as optional rather than truthy-coercing it', () => {
    const w = toWorkflow({
      workflow: { name: 'w', inputs: { a: {}, b: { required: false } } },
      source: 'project',
    });
    expect(w.inputs.map(i => i.required)).toEqual([false, false]);
  });
});
