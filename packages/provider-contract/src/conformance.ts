import { providerFailureSchema, type ProviderFailureClass } from './failure';

/**
 * Checks any provider, built in or a plugin, against the contract. The provider owns its
 * fixtures (how to drive its SDK into each state); these checks read only what it emitted.
 * Each check returns one line per violation, so an empty list means the provider conforms.
 */

/** One way to make the provider fail, and the class it must report for it. */
export interface ProviderFailureCase {
  name: string;
  expected: ProviderFailureClass;
  /** Runs one provider turn and yields its stream chunks. */
  run: () => AsyncIterable<unknown>;
}

function isResultChunk(chunk: unknown): chunk is { type: 'result'; failure?: unknown } {
  return (
    typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'result'
  );
}

/** A failed turn ends in exactly one result whose `failure` parses and carries the expected class. */
export async function checkFailureClasses(
  cases: readonly ProviderFailureCase[]
): Promise<string[]> {
  const violations: string[] = [];
  for (const failureCase of cases) {
    const results: { failure?: unknown }[] = [];
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
    const failure = results[0].failure;
    if (failure === undefined) {
      violations.push(`${failureCase.name}: result carries no failure`);
      continue;
    }
    const parsed = providerFailureSchema.safeParse(failure);
    if (!parsed.success) {
      violations.push(`${failureCase.name}: failure is malformed (${parsed.error.message})`);
    } else if (parsed.data.class !== failureCase.expected) {
      violations.push(
        `${failureCase.name}: reported ${parsed.data.class}, expected ${failureCase.expected}`
      );
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
