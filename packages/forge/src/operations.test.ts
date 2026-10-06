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

test('new check observations round trip attempts and independent approval evidence', () => {
  const unit = { ...failed, rerun: { id: 'opaque-group', attempt: 4 } };
  const observation = {
    ref: { repo: { host: 'forge', path: 'nested/group/repo' }, number: 1 },
    revision: 'opaque-full-id',
    units: [unit],
    summary: summarizeChecks([unit]),
    required: null,
    approvalPending: true,
  };
  expect(checksObservationSchema.parse(JSON.parse(JSON.stringify(observation)))).toEqual(
    observation
  );
  expect(
    checksObservationSchema.parse({ ...observation, units: [], summary: summarizeChecks([]) })
      .approvalPending
  ).toBe(true);
});

test('merge conditions cannot disappear during validation and reruns cannot duplicate units', async () => {
  const { forgeRequestSchema } = await import('./operations');
  const ref = { repo: { host: 'forge', path: 'repo' }, number: 1 };
  expect(
    forgeRequestSchema.safeParse({
      operationId: '1',
      op: 'pr.merge',
      ref,
      method: 'merge',
      conditions: { head: 'head', extra: 'unsafe' },
    }).success
  ).toBe(false);
  const selected = { unit: failed.unit, rerun: null };
  for (const units of [[], [selected, selected]])
    expect(
      forgeRequestSchema.safeParse({
        operationId: '2',
        op: 'checks.rerun',
        ref,
        revision: 'head',
        units,
      }).success
    ).toBe(false);
});

test('failure evidence cannot belong to another operation or call observed reruns a refusal', async () => {
  const { mutationFailureSchema } = await import('./operations');
  const target = { repo: { host: 'forge', path: 'repo' }, number: 1 };
  expect(
    mutationFailureSchema.safeParse({
      op: 'pr.ready',
      target,
      outcome: 'outcome_unknown',
      merge: { method: 'merge', conditions: { head: 'head' } },
    }).success
  ).toBe(false);
  const unit = { unit: failed.unit, rerun: { id: 'run', attempt: 1 } };
  expect(
    mutationFailureSchema.safeParse({
      op: 'checks.rerun',
      target,
      outcome: 'refused',
      rerun: {
        revision: 'head',
        requested: [unit],
        observed: [{ ...unit, rerun: { id: 'run', attempt: 2 } }],
      },
    }).success
  ).toBe(false);
});
