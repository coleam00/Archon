import { expect, test } from 'bun:test';
import { checksObservationSchema, summarizeChecks, type CheckObservation } from './operations';

const failed: CheckObservation = {
  unit: { kind: 'commit_status', id: '42', name: 'external-ci' },
  nativeState: 'failure',
  phase: 'completed',
  nativeResult: 'failure',
  result: 'failure',
  state: 'red',
};
test('cannot certify green or none when enumerated external statuses are red', () => {
  const observation = {
    ref: { repo: { host: 'forge.example', path: 'a/b/c' }, number: 1 },
    revision: 'opaque-object-id',
    units: [failed],
    required: null,
    summary: summarizeChecks([failed]),
  };
  expect(checksObservationSchema.parse(observation).summary.state).toBe('red');
  expect(
    checksObservationSchema.safeParse({ ...observation, summary: summarizeChecks([]) }).success
  ).toBe(false);
});

test('preserves unit kind/id and revision across wire serialization', () => {
  const observation = {
    ref: { repo: { host: 'forge.example', path: 'a/b/c' }, number: 1 },
    revision: 'a'.repeat(64),
    units: [failed],
    required: null,
    summary: summarizeChecks([failed]),
  };
  expect(checksObservationSchema.parse(JSON.parse(JSON.stringify(observation)))).toEqual(
    observation
  );
});
