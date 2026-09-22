import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checksStateSchema,
  forgePrRecordSchema,
  type ChecksObservation as ContractObservation,
  type ForgePrRecord,
} from '../../../packages/forge/src/operations';
import {
  CHECK_STATES,
  type ChecksObservation as PackObservation,
  parsePrRecord,
  type PrRecord,
  type QualifiedPr,
} from '../../workflows/sdlc/.shared/forge';
import type { PrRef } from '../../../packages/forge/src/identity';

// The pack is standalone and cannot import runtime packages. These assignments
// check that its consumed projection stays compatible with the owning wire type.
const consumesObservation = (value: ContractObservation): PackObservation => value;
const consumesPr = (value: PrRef): QualifiedPr => value;
const producesPr = (value: QualifiedPr): PrRef => value;
const consumesRecord = (value: ForgePrRecord): PrRecord => value;
const producesRecord = (value: PrRecord): ForgePrRecord => value;

test('standalone pack consumes the owning forge vocabulary and qualified identity', () => {
  expect([...CHECK_STATES]).toEqual(checksStateSchema.options);
  const ref = { repo: { host: 'forge.example', path: 'group/team/repo' }, number: 42 };
  expect(producesPr(consumesPr(ref))).toEqual(ref);
  const observation: ContractObservation = {
    ref,
    revision: 'opaque-object-id',
    units: [],
    required: null,
    summary: {
      state: 'none',
      counts: { total: 0, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 },
    },
  };
  expect(consumesObservation(observation)).toBe(observation);
});

test('standalone pack projects the complete owner-qualified PR record', () => {
  const owner: ForgePrRecord = {
    schemaVersion: 1,
    repo: { host: 'forge.example', path: 'group/repo' },
    number: 42,
    url: 'https://forge.example/group/repo/pulls/42',
    head: 'feature',
    base: 'dev',
    is_draft: true,
    state: 'open',
    head_repo: { host: 'fork.example', path: 'author/repo' },
    head_revision: 'head-object',
    base_revision: 'base-object',
    maintainer_can_modify: true,
  };
  const projected = parsePrRecord(owner);
  expect(forgePrRecordSchema.parse(projected)).toEqual(owner);
  expect(producesRecord(consumesRecord(projected))).toEqual(owner);
  expect(projected.repo).toEqual({ host: 'forge.example', path: 'group/repo' });
  expect(projected.head_repo).toEqual({ host: 'fork.example', path: 'author/repo' });
  expect(projected.head_revision).toBe('head-object');
});

test('delivery passes the complete PR record to every review and deterministic publisher', () => {
  const root = join(import.meta.dir, '..', '..', 'workflows', 'sdlc');
  const delivery = readFileSync(join(root, 'deliver', 'archon-deliver.yaml'), 'utf8');
  expect(delivery.match(/scope: "\$pr\.output"/g)).toHaveLength(3);
  expect(delivery).toContain('script: publish-pr-body');
  expect(delivery).toContain('script: flip-ready');
  expect(delivery).not.toContain('requires: [github]');

  const pr = readFileSync(join(root, 'pr', 'archon-pr.yaml'), 'utf8');
  expect(pr).toContain('script: publish-pr');
  expect(pr).toContain('output_format: { type: object }');

  const review = readFileSync(join(root, 'review', 'archon-review.yaml'), 'utf8');
  expect(review).toContain('script: publish-review');
});
