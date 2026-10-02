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

/** Everything a provider supplies to be checked. Later checks add their own fixtures here. */
export interface ProviderConformanceSuite {
  failureCases: readonly ProviderFailureCase[];
}

export async function runProviderConformance(suite: ProviderConformanceSuite): Promise<string[]> {
  return checkFailureClasses(suite.failureCases);
}
