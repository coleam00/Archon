import { expect, test } from 'bun:test';
import {
  checksStateSchema,
  type ChecksObservation as ContractObservation,
} from '../../../packages/forge/src/operations';
import {
  CHECK_STATES,
  type ChecksObservation as PackObservation,
  type QualifiedPr,
} from '../../workflows/sdlc/.shared/forge';
import type { PrRef } from '../../../packages/forge/src/identity';

// The pack is standalone and cannot import runtime packages. These assignments
// check that its consumed projection stays compatible with the owning wire type.
const consumesObservation = (value: ContractObservation): PackObservation => value;
const consumesPr = (value: PrRef): QualifiedPr => value;
const producesPr = (value: QualifiedPr): PrRef => value;

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
