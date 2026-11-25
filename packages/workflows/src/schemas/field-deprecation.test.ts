import { expect, test } from 'bun:test';
import { z } from 'zod';
import { dagNodeFlatSchema, nodeFieldDeprecations } from './dag-node';
import { deprecatedField, deprecatedFields } from './field-deprecation';

test('live authored fields project nested paths, original releases and shared owners', () => {
  const fields = nodeFieldDeprecations();
  expect(fields.map(field => [field.path, field.metadata.since])).toEqual([
    [['loop', 'until'], '0.10.0'],
    [['loop', 'interactive'], '0.10.0'],
    [['loop_group', 'until'], '0.10.0'],
    [['loop_group', 'interactive'], '0.10.0'],
    [['approval'], '0.12.0'],
    [['approval', 'decisions'], '0.12.0'],
    [['approval', 'capture_response'], '0.10.0'],
    [['approval', 'on_reject'], '0.10.0'],
  ]);
  const untils = fields.filter(field => field.metadata.kind === 'prose_until');
  expect(untils[0].schema).toBe(untils[1].schema);
  expect(untils[0].replacement).toContain('loop.until_field');
  expect(untils[1].replacement).not.toContain('until_field');
});

test('only reachable declarations project, including optional wrappers and object children', () => {
  const legacy = deprecatedField(z.boolean().optional(), {
    since: '0.10.0',
    kind: 'legacy_pause',
    shape: 'capture_response',
    subject: path => `'${path.join('.')}' is deprecated.`,
    replacement: 'Use the answer text.',
  });
  const owner = z.object({ nested: z.object({ legacy }) }).partial();
  expect(deprecatedFields(owner).map(field => field.path)).toEqual([['nested', 'legacy']]);
  expect(owner.parse({ nested: { legacy: false } })).toEqual({ nested: { legacy: false } });
  expect(deprecatedFields(owner.omit({ nested: true }))).toEqual([]);
  expect(
    deprecatedFields(z.object({ nested: z.object({ legacy: z.boolean().optional() }) }))
  ).toEqual([]);
  expect(
    deprecatedFields(z.object({ array: z.array(owner), record: z.record(z.string(), owner) }))
  ).toEqual([]);
});

test('removing an accepted field removes its entire deprecation subtree', () => {
  const withoutApproval = deprecatedFields(dagNodeFlatSchema.omit({ approval: true }));
  expect(withoutApproval.map(field => field.path)).toEqual([
    ['loop', 'until'],
    ['loop', 'interactive'],
    ['loop_group', 'until'],
    ['loop_group', 'interactive'],
  ]);
});
