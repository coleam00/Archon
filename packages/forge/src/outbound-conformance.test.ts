import { expect, test } from 'bun:test';
import { summarizeChecks, type CheckObservation, type ForgeResponse } from './operations';
import { runForgeReadConformance, type ForgeReadConformanceCase } from './outbound-conformance';

const ref = { repo: { host: 'forge.example', path: 'owner/repo' }, number: 1 };
const check: CheckObservation = {
  unit: { kind: 'check', id: '42', name: 'build' },
  nativeState: 'completed',
  phase: 'completed',
  nativeResult: 'success',
  result: 'success',
  state: 'green',
  rerun: { id: 'build-run', attempt: 2 },
};
const fixture: ForgeReadConformanceCase = {
  name: 'build',
  request: { operationId: 'observe', op: 'checks.state', ref },
  expected: {
    revision: 'head',
    state: 'green',
    approvalPending: false,
    units: [{ ...check.unit, rerun: check.rerun }],
  },
};

function observation(units: CheckObservation[]): ForgeResponse {
  return {
    operationId: 'observe',
    ok: true,
    result: {
      op: 'checks.state',
      value: {
        ref,
        revision: 'head',
        units,
        summary: summarizeChecks(units),
        required: null,
        approvalPending: false,
      },
    },
  };
}

test('read conformance accepts matching unit identity and rerun attempt', async () => {
  expect(await runForgeReadConformance(async () => observation([check]), [fixture])).toEqual([]);
});

test('read conformance keeps every unit failure in fixture order', async () => {
  const missing = { ...check.unit, id: 'missing', rerun: null };
  expect(
    await runForgeReadConformance(
      async () => observation([{ ...check, rerun: null }]),
      [
        {
          ...fixture,
          expected: { ...fixture.expected, units: [...fixture.expected.units, missing] },
        },
      ]
    )
  ).toEqual([
    'build: rerun identity or attempt differs',
    'build: rerun identity or attempt differs',
    'build: enumerated unit identities differ',
  ]);
});
