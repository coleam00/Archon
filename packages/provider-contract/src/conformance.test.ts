import { describe, expect, test } from 'bun:test';
import {
  checkFailureClasses,
  runProviderConformance,
  type ProviderFailureCase,
} from './conformance';

function turn(...chunks: unknown[]): () => AsyncIterable<unknown> {
  return async function* () {
    yield* chunks;
  };
}

const conforming: ProviderFailureCase = {
  name: 'expired key',
  expected: 'auth',
  run: turn(
    { type: 'assistant', content: 'partial' },
    { type: 'result', isError: true, failure: { class: 'auth', evidence: 'HTTP 401' } }
  ),
};

describe('failure-class conformance', () => {
  test('a provider that reports the expected class conforms', async () => {
    expect(await runProviderConformance({ failureCases: [conforming] })).toEqual([]);
  });

  test.each<[string, ProviderFailureCase, string]>([
    [
      'wrong class',
      {
        ...conforming,
        run: turn({ type: 'result', failure: { class: 'transient', evidence: 'x' } }),
      },
      'expired key: reported transient, expected auth',
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
