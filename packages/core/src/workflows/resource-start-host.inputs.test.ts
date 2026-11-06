/**
 * A trigger binding supplies a run's inputs the way `--input` does, so it meets the same
 * contract: the workflow's own inputs, or its pack's settings checked against their types.
 */
import { describe, expect, test } from 'bun:test';
import type { WorkflowPack } from '@archon/workflows/schemas/pack-settings';
import { resolveBindingInputs } from './resource-start-host';

const pack: WorkflowPack = {
  key: 'alpha',
  source: 'project',
  settings: { strict: { type: 'bool' }, forge: { type: 'enum', values: ['gh', 'glab'] } },
};
const binding = (inputs: Record<string, unknown>) =>
  ({ launch: { inputs } }) as Parameters<typeof resolveBindingInputs>[0];

describe('trigger binding inputs and pack settings', () => {
  test('a pack setting is accepted as its checked text, beside a declared input', () => {
    const workflow = { name: 'packed', inputs: { count: {} }, pack };
    expect(resolveBindingInputs(binding({ count: 7, strict: true }), workflow)).toEqual({
      count: 7,
      strict: 'true',
    });
  });

  test.each([
    ['declares inputs', { count: {} }],
    ['declares no inputs', undefined],
  ])('a mistyped pack setting is refused when the workflow %s', (_label, inputs) => {
    expect(() =>
      resolveBindingInputs(binding({ strict: 'maybe' }), { name: 'packed', inputs, pack })
    ).toThrow("pack setting 'strict' must be true or false");
  });

  test('a name neither the workflow nor its pack declares is still refused', () => {
    expect(() =>
      resolveBindingInputs(binding({ colour: 'red' }), {
        name: 'packed',
        inputs: { count: {} },
        pack,
      })
    ).toThrow('Pack settings: forge, strict.');
  });
});

describe('trigger event inputs and pack settings', () => {
  const eventBinding = (eventInputs: Record<string, unknown>) =>
    ({ launch: { inputs: {} }, eventInputs }) as Parameters<typeof resolveBindingInputs>[0];

  test('an event input may set a pack setting even when the workflow declares no inputs', () => {
    expect(
      resolveBindingInputs(eventBinding({ forge: 'glab' }), {
        name: 'packed',
        inputs: undefined,
        pack,
      })
    ).toEqual({ forge: 'glab' });
    expect(() =>
      resolveBindingInputs(eventBinding({ forge: 'svn' }), {
        name: 'packed',
        inputs: undefined,
        pack,
      })
    ).toThrow("pack setting 'forge' must be one of gh, glab");
  });

  test('an event input that is no pack setting still needs a declared input', () => {
    expect(() =>
      resolveBindingInputs(eventBinding({ title: 'x', forge: 'gh' }), {
        name: 'packed',
        inputs: undefined,
        pack,
      })
    ).toThrow("cannot pass event-mapped input 'title'");
  });
});
