/**
 * The intake label binding the pack declares starts intake for exactly the labels intake
 * treats as requests. The declaration is YAML the engine reads and the list is pack code,
 * so this test is what keeps the two equal.
 */
import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUEST_LABELS } from '../../workflows/sdlc/.shared/labels';

interface Declaration {
  bindings: Record<string, { event?: { predicates?: { field: string; in?: string[] }[] } }>;
}

it('declares the intake label binding for the request labels', () => {
  const declaration = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../../workflows/sdlc/.pack/pack.yaml'), 'utf8')
  ) as Declaration;
  const predicates = declaration.bindings['intake-labels']?.event?.predicates ?? [];
  expect(predicates.map(predicate => predicate.field)).toEqual(['label.name']);
  expect([...(predicates[0]?.in ?? [])].sort()).toEqual([...REQUEST_LABELS].sort());
});
