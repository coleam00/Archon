import { describe, expect, test } from 'bun:test';
import {
  checkFailureClasses,
  checkSettled,
  runProviderConformance,
  type ProviderFailureCase,
  type ProviderTurnCase,
} from './conformance';

function turn(...chunks: unknown[]): () => AsyncIterable<unknown> {
  return async function* () {
    yield* chunks;
  };
}

const conforming: ProviderFailureCase = {
  name: 'expired key',
  expected: 'auth',
  evidence: 'HTTP 401',
  run: turn(
    { type: 'assistant', content: 'partial' },
    { type: 'result', isError: true, failure: { class: 'auth', evidence: 'HTTP 401' } },
    { type: 'settled' }
  ),
};

const settlingTurn: ProviderTurnCase = {
  name: 'background work',
  run: turn(
    { type: 'result' },
    { type: 'background_tasks', tasks: [] },
    { type: 'result' },
    { type: 'settled' }
  ),
};

describe('failure-class conformance', () => {
  test('a provider that reports the expected class conforms', async () => {
    expect(
      await runProviderConformance({ failureCases: [conforming], turns: [settlingTurn] })
    ).toEqual([]);
  });

  test.each<[string, ProviderFailureCase, string]>([
    [
      'wrong class',
      {
        ...conforming,
        run: turn({
          type: 'result',
          isError: true,
          failure: { class: 'transient', evidence: 'HTTP 401' },
        }),
      },
      'expired key: reported transient, expected auth',
    ],
    [
      'evidence that drops the vendor text',
      {
        ...conforming,
        run: turn({
          type: 'result',
          isError: true,
          failure: { class: 'auth', evidence: 'authentication failed' },
        }),
      },
      'expired key: evidence does not keep the vendor text "HTTP 401"',
    ],
    [
      'a failed result without isError',
      {
        ...conforming,
        run: turn({ type: 'result', failure: { class: 'auth', evidence: 'HTTP 401' } }),
      },
      'expired key: a failed result does not set isError',
    ],
    [
      'no failure on the result',
      { ...conforming, run: turn({ type: 'result', isError: true, errors: ['401'] }) },
      'expired key: result carries no failure',
    ],
    [
      'malformed failure',
      { ...conforming, run: turn({ type: 'result', failure: { class: 'auth', evidence: '' } }) },
      'expired key: failure is malformed',
    ],
    [
      'no result',
      { ...conforming, run: turn({ type: 'assistant', content: 'x' }) },
      'expired key: expected one result, got 0',
    ],
    [
      'two results',
      {
        ...conforming,
        run: turn(
          { type: 'result', failure: { class: 'auth', evidence: 'a' } },
          { type: 'result', failure: { class: 'auth', evidence: 'b' } }
        ),
      },
      'expired key: expected one result, got 2',
    ],
    [
      'throws instead of reporting',
      {
        ...conforming,
        run: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('Claude Code auth error: 401')),
          }),
        }),
      },
      'expired key: threw instead of reporting a typed failure',
    ],
  ])('flags %s', async (_label, failureCase, violation) => {
    const violations = await checkFailureClasses([failureCase]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toStartWith(violation);
  });
});

describe('settled conformance', () => {
  test.each<[string, ProviderTurnCase, string]>([
    [
      'no settled',
      { ...settlingTurn, run: turn({ type: 'result' }) },
      'background work: expected one settled, got 0',
    ],
    [
      'two settled',
      { ...settlingTurn, run: turn({ type: 'result' }, { type: 'settled' }, { type: 'settled' }) },
      'background work: expected one settled, got 2',
    ],
    [
      'settled before the final result',
      { ...settlingTurn, run: turn({ type: 'result' }, { type: 'settled' }, { type: 'result' }) },
      'background work: settled is not the last chunk',
    ],
    [
      'settled with no result',
      { ...settlingTurn, run: turn({ type: 'settled' }) },
      'background work: settled arrives before any result',
    ],
  ])('flags %s', async (_label, turnCase, violation) => {
    const violations = await checkSettled([turnCase]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toStartWith(violation);
  });

  test('a failed turn must settle too', async () => {
    const unsettledFailure: ProviderFailureCase = {
      ...conforming,
      run: turn({
        type: 'result',
        isError: true,
        failure: { class: 'auth', evidence: 'HTTP 401' },
      }),
    };
    expect(
      await runProviderConformance({ failureCases: [unsettledFailure], turns: [settlingTurn] })
    ).toEqual(['expired key: expected one settled, got 0']);
  });
});
