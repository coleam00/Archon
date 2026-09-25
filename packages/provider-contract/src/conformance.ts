import { providerFailureSchema, type ProviderFailureClass } from './failure';

/**
 * Checks any provider, built in or a plugin, against the contract. The provider owns its
 * fixtures (how to drive its SDK into each state); these checks read only what it emitted.
 * Each check returns one line per violation, so an empty list means the provider conforms.
 */

/** One way to make the provider fail, the class it must report, and the vendor text it must keep. */
export interface ProviderFailureCase {
  name: string;
  expected: ProviderFailureClass;
  /** Vendor text the failure's `evidence` must contain: the class never replaces the evidence. */
  evidence: string;
  /** Runs one provider turn and yields its stream chunks. */
  run: () => AsyncIterable<unknown>;
}

function isResultChunk(
  chunk: unknown
): chunk is { type: 'result'; failure?: unknown; isError?: unknown } {
  return (
    typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'result'
  );
}

/**
 * A failed turn ends in exactly one result whose `failure` parses, carries the expected
 * class and keeps the vendor's evidence, and which still sets `isError` for readers that
 * do not read `failure` yet.
 */
export async function checkFailureClasses(
  cases: readonly ProviderFailureCase[]
): Promise<string[]> {
  const violations: string[] = [];
  for (const failureCase of cases) {
    const results: { failure?: unknown; isError?: unknown }[] = [];
    try {
      for await (const chunk of failureCase.run()) {
        if (isResultChunk(chunk)) results.push(chunk);
      }
    } catch (error) {
      violations.push(
        `${failureCase.name}: threw instead of reporting a typed failure (${(error as Error).message})`
      );
      continue;
    }
    if (results.length !== 1) {
      violations.push(`${failureCase.name}: expected one result, got ${String(results.length)}`);
      continue;
    }
    const { failure, isError } = results[0];
    if (failure === undefined) {
      violations.push(`${failureCase.name}: result carries no failure`);
      continue;
    }
    const parsed = providerFailureSchema.safeParse(failure);
    if (!parsed.success) {
      violations.push(`${failureCase.name}: failure is malformed (${parsed.error.message})`);
      continue;
    }
    if (parsed.data.class !== failureCase.expected) {
      violations.push(
        `${failureCase.name}: reported ${parsed.data.class}, expected ${failureCase.expected}`
      );
    }
    if (!parsed.data.evidence.includes(failureCase.evidence)) {
      violations.push(
        `${failureCase.name}: evidence does not keep the vendor text "${failureCase.evidence}"`
      );
    }
    if (isError !== true) {
      violations.push(`${failureCase.name}: a failed result does not set isError`);
    }
  }
  return violations;
}

/** One provider turn, for checks that hold for every turn whether it succeeds or fails. */
export interface ProviderTurnCase {
  name: string;
  /** Runs one provider turn and yields its stream chunks. */
  run: () => AsyncIterable<unknown>;
}

function chunkType(chunk: unknown): unknown {
  return typeof chunk === 'object' && chunk !== null
    ? (chunk as { type?: unknown }).type
    : undefined;
}

/**
 * Every turn ends in exactly one `settled`, sent as the last chunk, after the turn's
 * `result`. The engine finishes a node on it, so a provider that never sends it keeps the
 * node open until its stream ends, and one that sends it early ends the node while work
 * still runs.
 */
export async function checkSettled(cases: readonly ProviderTurnCase[]): Promise<string[]> {
  const violations: string[] = [];
  for (const turnCase of cases) {
    const types: unknown[] = [];
    try {
      for await (const chunk of turnCase.run()) types.push(chunkType(chunk));
    } catch (error) {
      violations.push(`${turnCase.name}: threw instead of settling (${(error as Error).message})`);
      continue;
    }
    const settledAt = types.indexOf('settled');
    const settledCount = types.filter(type => type === 'settled').length;
    if (settledCount !== 1) {
      violations.push(`${turnCase.name}: expected one settled, got ${String(settledCount)}`);
      continue;
    }
    if (settledAt !== types.length - 1) {
      violations.push(`${turnCase.name}: settled is not the last chunk`);
    }
    if (!types.slice(0, settledAt).includes('result')) {
      violations.push(`${turnCase.name}: settled arrives before any result`);
    }
  }
  return violations;
}

/** Everything a provider supplies to be checked. Later checks add their own fixtures here. */
export interface ProviderConformanceSuite {
  failureCases: readonly ProviderFailureCase[];
  /** Turns that succeed, including one whose result arrives before its work drains. */
  turns: readonly ProviderTurnCase[];
}

export async function runProviderConformance(suite: ProviderConformanceSuite): Promise<string[]> {
  return [
    ...(await checkFailureClasses(suite.failureCases)),
    // A failed turn settles too.
    ...(await checkSettled([...suite.turns, ...suite.failureCases])),
  ];
}
