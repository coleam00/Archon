import { describe, test, expect } from 'bun:test';
import { VARIANTS, VARIANT_REGISTRY, isVariantId } from './registry';
import { wireKeysWithRole, type WireDagNode } from '../types';
import { fromWorkflowDefinition } from '../model/from-workflow';
import { toWorkflowDefinition } from '../model/to-workflow';
import { waitToDag } from './wait';

describe('isVariantId', () => {
  test('accepts every canonical variant id', () => {
    for (const variant of VARIANTS) {
      expect(isVariantId(variant)).toBe(true);
    }
  });

  test('rejects unknown strings (e.g. a foreign drag payload)', () => {
    for (const bad of ['', 'Prompt', 'workflow', 'node', 'application/json', 'loop ']) {
      expect(isVariantId(bad)).toBe(false);
    }
  });
});

describe('variant wire keys', () => {
  test('every wire key marked as a variant key is carried by at least one variant', () => {
    // A key given the `variant` role but listed by no variant would be dropped on save
    // with only a warning, which is the loss the role record exists to prevent.
    const carried = new Set<string>(VARIANTS.flatMap(v => [...VARIANT_REGISTRY[v].wireKeys]));
    expect(wireKeysWithRole('variant').filter(key => !carried.has(key))).toEqual([]);
  });
});

describe('variant converters carry every key they list', () => {
  // One node per variant with every key of its `wireKeys` set. Listing a key in
  // `wireKeys` only stops the importer from warning about it; whether it survives
  // is up to the variant's converters, which this pins.
  const FULL: { [K in (typeof VARIANTS)[number]]: WireDagNode } = {
    prompt: { id: 'n', prompt: 'do it' },
    command: { id: 'n', command: 'plan', with: { slug: '$a.output' } },
    bash: { id: 'n', bash: 'echo hi', timeout: 1000, on_timeout: 'skip' },
    script: {
      id: 'n',
      script: 'run',
      runtime: 'uv',
      deps: ['httpx'],
      timeout: 1000,
      on_timeout: 'skip',
      with: { part: '$INPUTS.part' },
    },
    loop: {
      id: 'n',
      loop: { prompt: 'again', until: 'DONE', max_iterations: 3, fresh_context: true },
      timeout: 1000,
    },
    approval: { id: 'n', approval: { message: 'ok?' } },
    wait: { id: 'n', wait: { duration_ms: 1000 } },
    cancel: { id: 'n', cancel: 'stop' },
  };

  for (const variant of VARIANTS) {
    test(`${variant}: the fixture sets every wire key and the round-trip keeps them all`, () => {
      const node = FULL[variant];
      const missing = VARIANT_REGISTRY[variant].wireKeys.filter(key => !(key in node));
      expect(missing).toEqual([]);

      const { workflow, issues } = fromWorkflowDefinition({
        name: 'w',
        description: 'd',
        nodes: [node],
      });
      expect(issues).toEqual([]);
      expect(toWorkflowDefinition(workflow).nodes[0]).toEqual(node);
    });
  }
});

describe('wait draft serialization', () => {
  test('keeps clear duration and deadline edits renderable for validation', () => {
    expect(waitToDag({ duration_ms: undefined })).toEqual({ wait: { duration_ms: undefined } });
    expect(waitToDag({ event: 'checks.complete', deadline_ms: undefined })).toEqual({
      wait: { event: 'checks.complete', deadline_ms: undefined },
    });
  });
});
